import Foundation
import AVFoundation

/// 原生通话客户端：直接连通话中继 /v1/call，麦克风 → PCM16/16k（或 Opus）上行，下行播出来。
/// 协议见 docs/PROTOCOL.md：二进制帧 = 音频，JSON = 事件。没有界面——事件经 onEvent 往外报。
/// 为什么不用网页：CallKit 接听不会把 app 拉到前台，WKWebView 在后台起不了麦克风。
///
/// 音频这一路踩过的坑（都是 9-21 实测）：
/// · 引擎要等 CallKit 的 didActivate 再起；**不许自己 setActive**，CallKit 通话里自己激活会哑。
/// · 48k→16k 用系统转换器配回调会丢帧（用户说 11 秒只转出一两个字），整数倍自己抽。
/// · 播放不用 AVAudioPlayerNode：语音处理一开引擎会重起一次，它排好的音频全作废、还得手动 play()，
///   于是「聊到一半没声音」。换成 AVAudioSourceNode 从环形缓冲拉，引擎怎么重起都自己续上。
final class AICallClient: NSObject, URLSessionWebSocketDelegate {
    private let url: URL
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private let engine = AVAudioEngine()
    private var source: AVAudioSourceNode?
    private var decimate = 0
    private var carry: [Float] = []
    private let wire = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    private let playFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    private var audioOn = false
    private var closed = false
    var onEnded: ((String) -> Void)?
    var onEvent: ((String, [String: Any]) -> Void)?
    var onDebug: ((String) -> Void)?

    // 下行环形缓冲：网络线程写，渲染线程读
    private let ringLock = NSLock()
    private var ring: [Float] = []
    private var ringHead = 0
    private var pulled = 0            // 渲染线程真拉走了多少采样（证明声音在往喇叭走）

    private var sentFrames = 0, taps = 0, recvFrames = 0, restarts = 0, barges = 0
    // 断线重连（9-21 实测：socket 中途悄悄死了，两头都不知道，用户说什么都没人听）
    private var sessionId = ""
    private var lastRx = Date()
    private var lastPong = Date()      // 只有我发的 ping 被回了才算线是活的——半死的线下行照常、上行全卡（9-21 实测 38 秒）
    private var reconnects = 0
    private var reconnecting = false
    private let baseURL: URL
    private var micLevel: Float = 0
    private var upBuf = Data()
    private var opus: AICallOpus? = AICallOpus()      // 建不出来就走 PCM
    private var upPackets = 0
    private var inflight = 0
    private var tickN = 0
    private var rttMs: Double = 300      // pong 往返的平滑值，阈值按它算
    private var lastReconnectAt = Date.distantPast
    private var openedAt = Date()
    private var micPeak: Float = 0      // 这个 tick 窗口里的峰值，tick 时清零
    private var loud = 0
    private var lastBarge = Date.distantPast
    private var observers: [NSObjectProtocol] = []
    private var pingTimer: DispatchSourceTimer?

    /// 静音（通话屏的静音键 / 系统锁屏那颗，都走 CXSetMutedCallAction）：照常发帧、内容全零，
    /// 中继那边的节奏和心跳不受影响，只是听不见用户
    var muted = false

    /// direction：in = AI 打给用户（推送来电），out = 用户打给 AI
    init(relayURL: String, ticket: String, opener: String, direction: String = "in", lang: String = "zh") {
        var c = URLComponents(string: relayURL)!
        var q = [URLQueryItem(name: "ticket", value: ticket), URLQueryItem(name: "client", value: "ios"),
                 URLQueryItem(name: "direction", value: direction), URLQueryItem(name: "lang", value: lang),
                 URLQueryItem(name: "codec", value: AICallOpus() != nil ? "opus" : "pcm")]
        if !opener.isEmpty { q.append(URLQueryItem(name: "opener", value: opener)) }
        c.queryItems = q
        url = c.url!
        baseURL = url
        super.init()
    }

    func connect() {
        open(url)
    }

    private func open(_ u: URL) {
        session?.invalidateAndCancel()
        // 标成 VoIP 流量：后台时系统不压它的优先级、不掐它（9-21 实测上行会周期性卡十几秒）
        let cfg = URLSessionConfiguration.default
        cfg.networkServiceType = .voip
        cfg.shouldUseExtendedBackgroundIdleMode = true
        cfg.waitsForConnectivity = false
        let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        session = s
        let t = s.webSocketTask(with: u)
        task = t
        lastRx = Date(); lastPong = Date(); openedAt = Date()
        t.resume()
        receive(on: t)
    }

    /// 10 秒没任何回音就换一条 socket 接回同一通（中继认 ?resume=<id>）。最多试 5 次
    private func reconnect(_ why: String) {
        guard !closed, !sessionId.isEmpty else { if sessionId.isEmpty { finish(why) }; return }
        // 单飞：上一次换线 3 秒内不再换（昨晚双发 resume，中继一毫秒内收到两条）
        guard !reconnecting, Date().timeIntervalSince(lastReconnectAt) > 3 else { return }
        reconnecting = true
        lastReconnectAt = Date()
        reconnects += 1
        // 不设上限：线一晚上能死十几次，每次都接得回来；中继那边 20 秒内接回都算同一通
        var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        var q = (c.queryItems ?? []).filter { $0.name != "resume" && $0.name != "opener" }
        q.append(URLQueryItem(name: "resume", value: sessionId))
        c.queryItems = q
        onDebug?("重连 #\(reconnects)：\(why)")
        inflight = 0
        open(c.url!)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in self?.reconnecting = false }
    }

    // MARK: 音频

    /// CallKit didActivate 之后调
    func startAudio() {
        guard !audioOn, !closed else { return }
        audioOn = true
        let sess = AVAudioSession.sharedInstance()
        let input = engine.inputNode
        do { try input.setVoiceProcessingEnabled(true) } catch { onDebug?("vp:\(error.localizedDescription)") }   // 系统回声消除
        let inFmt = input.outputFormat(forBus: 0)
        onDebug?("codec \(opus != nil ? "opus" : "pcm") · mic \(Int(inFmt.sampleRate))Hz · out \(sess.currentRoute.outputs.first?.portType.rawValue ?? "none") · vol \(Int(sess.outputVolume * 100))")

        let src = AVAudioSourceNode(format: playFmt) { [weak self] _, _, frameCount, abl in
            guard let self else { return noErr }
            let buffers = UnsafeMutableAudioBufferListPointer(abl)
            guard let out = buffers[0].mData?.assumingMemoryBound(to: Float.self) else { return noErr }
            let n = Int(frameCount)
            self.ringLock.lock()
            let avail = self.ring.count - self.ringHead
            let take = min(n, max(0, avail))
            if take > 0 {
                self.ring.withUnsafeBufferPointer { p in
                    let src = p.baseAddress! + self.ringHead
                    for i in 0..<take { out[i] = src[i] * 0.8 }   // 压一点，回声消除收敛得快
                }
                self.ringHead += take
                self.pulled += take
                if self.ringHead > 16000 * 4 { self.ring.removeFirst(self.ringHead); self.ringHead = 0 }
            }
            if take < n { (out + take).update(repeating: 0, count: n - take) }
            self.ringLock.unlock()
            return noErr
        }
        source = src
        engine.attach(src)
        engine.connect(src, to: engine.mainMixerNode, format: playFmt)
        installTap()

        // 配置变化（语音处理刚开、路由换了）：引擎停了，而且输入格式可能变了——采集器要**拆了重装**，
        // 只把引擎再拉起来的话 tap 挂在旧格式上一直发零（9-21 实测：路由先重起的那几通麦克风全是 0）
        observers.append(NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.rebuild("config change")
        })
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] n in
            let out = AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType.rawValue ?? "none"
            self?.onDebug?("route → \(out)")
            // 不在这里重起：配置变化的通知随后就到，那边会整个重建。只兜底：1 秒后还停着就重建
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                guard let self, self.audioOn, !self.closed, !self.engine.isRunning else { return }
                self.rebuild("route(兜底)")
            }
        })
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
            let t = (n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            if t == .ended { self?.rebuild("interruption ended") }
        })

        engine.prepare()
        do { try engine.start(); onDebug?("engine on") } catch { onDebug?("engine:\(error.localizedDescription)") }

        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in
            guard let self, !self.closed else { return }
            // 应用层心跳：中继收到 {type:ping} 回 {type:pong}。控制帧的 ping 经过 Cloudflare 不一定端到端，
            // 9-21 实测怀疑它让壳误判断线、每 16 秒换一次线。只认 JSON 回音
            if let d = try? JSONSerialization.data(withJSONObject: ["type": "ping", "t": Int(Date().timeIntervalSince1970 * 1000)]), let m = String(data: d, encoding: .utf8) {
                self.task?.send(.string(m)) { _ in }
            }
            // 阈值跟着往返时间走：至少 5 秒，或者 6 倍 RTT（用户那条线 RTT 大时别把好线当坏线换掉）
            // 刚建连的前 12 秒宽容：5G 冷启动上行会堵三四秒，这时换线只会越换越乱（9-22 实测开头连换三次）
            let young = Date().timeIntervalSince(self.openedAt) < 12
            let limit = young ? 12.0 : max(5.0, min(12.0, self.rttMs * 6 / 1000))
            let noPong = Date().timeIntervalSince(self.lastPong)
            if noPong > limit { self.reconnect("\(Int(noPong))s 没 pong（阈 \(Int(limit))s，RTT \(Int(self.rttMs))ms）") }
            else if !young && self.inflight > 30 { self.reconnect("上行积压 \(self.inflight) 包") }   // 3 秒的音频还没发出去，线堵了
            self.ensureRunning("tick")
            self.tickN += 1
            if self.tickN % 3 != 0 { return }   // 日志还是 6 秒一行
            self.ringLock.lock(); let pend = (self.ring.count - self.ringHead) / 16000; self.ringLock.unlock()
            self.onDebug?("tick 收\(self.recvFrames) 拉\(self.pulled / 16000)s 欠\(pend)s 发\(self.sentFrames) 麦峰\(Int(self.micPeak * 1000)) rtt\(Int(self.rttMs)) \(AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType.rawValue ?? "")")
            self.micPeak = 0
        }
        timer.resume()
        pingTimer = timer
    }

    private var tapFmt: AVAudioFormat?
    private func installTap() {
        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        tapFmt = fmt
        guard fmt.sampleRate > 0 else { onDebug?("tap: 输入格式为空"); return }
        let ratio = fmt.sampleRate / wire.sampleRate
        decimate = max(1, Int(ratio.rounded()))
        carry = []
        input.installTap(onBus: 0, bufferSize: 2048, format: fmt) { [weak self] buf, _ in self?.pushUp(buf) }
    }

    /// 整个重建：拆 tap、按新格式重装、引擎再起。⚠️ 不碰 AVAudioSession.setActive——那是 CallKit 的活
    private func rebuild(_ why: String) {
        guard audioOn, !closed else { return }
        restarts += 1
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        installTap()
        if let src = source { engine.disconnectNodeOutput(src); engine.connect(src, to: engine.mainMixerNode, format: playFmt) }
        engine.prepare()
        do { try engine.start(); onDebug?("\(why) → 重建 #\(restarts) · mic \(Int(tapFmt?.sampleRate ?? 0))Hz ÷\(decimate)") }
        catch {
            onDebug?("\(why) → 重建失败: \(error.localizedDescription)")
            if restarts < 8 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.rebuild(why) } }
        }
    }

    /// 引擎停了就拉起来（心跳用）
    private func ensureRunning(_ why: String) {
        guard audioOn, !closed, !engine.isRunning else { return }
        rebuild(why)
    }

    private func pushUp(_ buf: AVAudioPCMBuffer) {
        guard audioOn, !closed, let t = task, t.state == .running, let ch = buf.floatChannelData else { return }
        taps += 1
        let n = Int(buf.frameLength)
        var samples = carry
        samples.append(contentsOf: UnsafeBufferPointer(start: ch[0], count: n))
        let outN = samples.count / decimate
        guard outN > 0 else { carry = samples; return }
        var out = [Int16](repeating: 0, count: outN)
        let inv = 1 / Float(decimate)
        var sq: Float = 0
        let gain: Float = muted ? 0 : 1
        for i in 0..<outN {
            var acc: Float = 0
            let base = i * decimate
            for k in 0..<decimate { acc += samples[base + k] }
            let v = max(-1, min(1, acc * inv * gain))
            sq += v * v
            out[i] = Int16(v * 32767)
        }
        let rms = (sq / Float(outN)).squareRoot()
        micLevel = 0.8 * micLevel + 0.2 * rms
        if rms > micPeak { micPeak = rms }
        // 插嘴（按能量，不等转写）：用户开口够响、连续 3 帧（约 0.3s），而AI 那边还有 >0.5s 没放完 → 掐
        loud = rms > 0.02 ? loud + 1 : 0
        if loud >= 3 {
            ringLock.lock(); let pending = ring.count - ringHead; ringLock.unlock()
            if pending > 8000, Date().timeIntervalSince(lastBarge) > 1.2 {
                lastBarge = Date(); barges += 1
                dropPending()
                if let d = try? JSONSerialization.data(withJSONObject: ["type": "interrupt", "heard": ""]), let m = String(data: d, encoding: .utf8) {
                    t.send(.string(m)) { _ in }
                }
                onDebug?("插嘴 #\(barges) 能量 \(Int(rms * 1000)) · 扔了 \(pending / 16000)s")
            }
        }
        carry = Array(samples[(outN * decimate)...])
        if let opus {
            // Opus：每 20ms 一包，攒 5 包（100ms）发一条 [u16 len][packet]…
            var floats = [Float](repeating: 0, count: outN)
            for i in 0..<outN { floats[i] = Float(out[i]) / 32767 }
            for p in opus.encode(floats) {
                var h = Data(count: 2); h[0] = UInt8(p.count >> 8); h[1] = UInt8(p.count & 0xff)
                upBuf.append(h); upBuf.append(p); upPackets += 1
            }
            if upPackets >= 5 {
                sentFrames += 1; upPackets = 0
                let d = upBuf; upBuf = Data()
                inflight += 1
                t.send(.data(d)) { [weak self] _ in self?.inflight -= 1 }
            }
            return
        }
        // 攒到 ~100ms 再发：23 条/秒的小消息在弱网上排队排得厉害，8~10 条/秒好走得多
        upBuf.append(out.withUnsafeBufferPointer { Data(buffer: $0) })
        if upBuf.count >= 3200 {   // 1600 采样 = 100ms
            sentFrames += 1
            let d = upBuf; upBuf = Data()
            inflight += 1
            t.send(.data(d)) { [weak self] _ in self?.inflight -= 1 }
        }
    }

    private func play(_ d: Data) {
        recvFrames += 1
        var f: [Float]
        if let opus {
            f = opus.decodeMessage(d)
            if f.isEmpty { return }
        } else {
            let n = d.count / 2
            guard n > 0 else { return }
            f = [Float](repeating: 0, count: n)
            d.withUnsafeBytes { raw in
                let src = raw.bindMemory(to: Int16.self)
                for i in 0..<n { f[i] = Float(src[i]) / 32768 }
            }
        }
        ringLock.lock()
        ring.append(contentsOf: f)
        // 引擎还没起来时先攒着（开场白），但别无限涨：最多留 60 秒
        if ring.count - ringHead > 16000 * 60 { ring.removeFirst(ringHead); ringHead = 0 }
        ringLock.unlock()
    }

    private func dropPending() {
        ringLock.lock(); ring.removeAll(); ringHead = 0; ringLock.unlock()
    }

    // MARK: 网络

    private func receive(on t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self, self.task === t else { return }   // 旧 socket 的回调不理
            switch result {
            case .failure(let e):
                if self.closed { return }
                self.reconnect("socket:\(e.localizedDescription)")
            case .success(let msg):
                self.lastRx = Date()
                switch msg {
                case .data(let d): self.play(d)
                case .string(let s): self.handle(s)
                @unknown default: break
                }
                self.receive(on: t)
            }
        }
    }

    private func handle(_ s: String) {
        guard let d = s.data(using: .utf8), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let type = j["type"] as? String else { return }
        onEvent?(type, j)
        switch type {
        case "pong":
            lastPong = Date()
            if let t = j["t"] as? Double { let rtt = Date().timeIntervalSince1970 * 1000 - t; if rtt > 0, rtt < 20000 { rttMs = 0.7 * rttMs + 0.3 * rtt } }
        case "ready": sessionId = j["session"] as? String ?? ""
        case "resumed": lastPong = Date(); onDebug?("接回来了（\(j["state"] as? String ?? "?")）")
        case "bye": finish(j["reason"] as? String ?? "bye")
        case "reply_done": if (j["hangup"] as? Bool) == true { finish("he_hung_up") }
        case "interrupted": dropPending()   // 打断：还没放的扔掉
        case "transcript":
            // 插嘴要客户端自己判（网页版也是）：中继那头模型早说完了、AI切回「听着」，
            // 可手机里还攒着好几秒没放完——这时用户开口，中继不当插嘴，声音就一直放，用户觉得它反应慢。
            // 系统回声消除开着，草稿里的字就是用户说的，不用等它长到几个字。
            if (j["final"] as? Bool) != true, let text = j["text"] as? String,
               text.unicodeScalars.filter({ CharacterSet.alphanumerics.contains($0) || ($0.value >= 0x4E00 && $0.value <= 0x9FFF) }).count >= 2 {   // 光一个句号不算（9-21 把开场白掐了）
                ringLock.lock(); let pending = ring.count - ringHead; ringLock.unlock()
                if pending > 1600, Date().timeIntervalSince(lastBarge) > 1.2 {   // 还有 >0.1s 没放
                    lastBarge = Date(); barges += 1
                    dropPending()
                    if let d = try? JSONSerialization.data(withJSONObject: ["type": "interrupt", "heard": text]), let m = String(data: d, encoding: .utf8) {
                        task?.send(.string(m)) { _ in }
                    }
                    onDebug?("插嘴 #\(barges)：\(text.prefix(12)) · 扔了 \(pending / 16000)s")
                }
            }
        default: break
        }
    }

    func hangup() {
        guard let t = task else { finish("local"); return }
        if let d = try? JSONSerialization.data(withJSONObject: ["type": "bye"]), let s = String(data: d, encoding: .utf8) {
            t.send(.string(s)) { _ in }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.finish("local") }
    }

    private func finish(_ reason: String) {
        guard !closed else { return }
        closed = true
        pingTimer?.cancel(); pingTimer = nil
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        if audioOn {
            audioOn = false
            engine.inputNode.removeTap(onBus: 0)
            if engine.isRunning { engine.stop() }
        }
        onDebug?("ended: \(reason) · 收\(recvFrames) 拉\(pulled / 16000)s 发\(sentFrames)")
        task?.cancel(with: .normalClosure, reason: nil)
        session?.invalidateAndCancel()
        onEnded?(reason)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task, !closed else { return }
        if closeCode == .normalClosure || closeCode == .goingAway { finish("closed:\(closeCode.rawValue)") }   // 中继正经关的（bye/重启）
        else { reconnect("closed:\(closeCode.rawValue)") }
    }
}
