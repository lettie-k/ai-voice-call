import Foundation
import CallKit
import AVFoundation
import UIKit

/// CallKit 这一层：AI 打给用户时手机像真来电一样响（锁屏也弹接听），用户打给 AI 时走系统的去电界面。
/// **不带任何界面**：状态通过 `AICallKitDelegate` 往外报，按钮、页面、样式都由你的 app 自己做。
///
/// 你要接的三样：
///   1. `AICallBackend`：去你的后端拿通话票据（见 docs/PROTOCOL.md），以及记一笔「没接」。
///   2. PushKit：收到 VoIP 推送后在回调里**同步**调 `handleIncomingPush(_:completion:)`（苹果的铁律：先上报来电）。
///   3. 拨出：用户点你的「打电话」按钮时调 `startOutgoing()`。
///
/// 我们踩过的坑（都写在注释对应位置）：
/// · 接听后**不许自己 setActive**，音频要等 CallKit 的 didActivate；但 didActivate 可能比连接建好还早，要补开麦。
/// · 听筒只收贴耳的声音，对着屏幕说话电平是 0——默认外放（.defaultToSpeaker）+ voiceChat（系统回声消除）。
/// · 去电时 CXHandle 的类型必须在 supportedHandleTypes 里，不然 CallKit 直接拒掉，一通都打不出去。
/// · 模拟器没有通话宿主，CallKit 去电一秒内被系统挂掉——模拟器里绕过 CallKit 直接连。

/// 你的后端
protocol AICallBackend: AnyObject {
    /// 用户打给 AI：拿一张短票据和中继地址
    func fetchTicket() async throws -> (ticket: String, relayURL: String)
    /// 来电没接 / 拒接 / 票过期（可选：在你的 app 里记一条未接来电）
    func reportMissed(callId: String, opener: String, reason: String) async
}

/// 往外报的事件——拿它们画你自己的界面
@MainActor
protocol AICallKitDelegate: AnyObject {
    func callDidConnect()                                   // 中继接上了
    func call(stateDidChange state: String)                 // listening / thinking / speaking
    func call(didReceive event: String, payload: [String: Any])   // 协议里的所有事件原样转出来（transcript、reply_delta、tool…）
    func call(notice message: String)                       // 出问题了，要显示给用户
    func callDidEnd(reason: String)
}

/// VoIP 推送体（你的后端发）：{ callId, ticket, relayURL, opener, expiresAt(毫秒) }
@MainActor
final class AICallKit: NSObject, CXProviderDelegate {
    struct Call {
        let uuid: UUID
        let callId: String
        var ticket: String
        var relayURL: String
        let opener: String
        let expiresAt: TimeInterval
        let outgoing: Bool
    }

    weak var delegate: AICallKitDelegate?
    let backend: AICallBackend
    /// 来电 / 通话记录里显示的名字；handle 用来让系统匹配通讯录里的头像（可以是一个邮箱样的字符串）
    let callerName: String
    let callerHandle: String

    private let provider: CXProvider
    private let controller = CXCallController()
    private(set) var current: Call?
    private var answered = false
    private var client: AICallClient?
    private var audioActive = false

    init(appName: String, callerName: String, callerHandle: String, iconName: String? = nil, backend: AICallBackend) {
        self.backend = backend
        self.callerName = callerName
        self.callerHandle = callerHandle
        let cfg = CXProviderConfiguration(localizedName: appName)
        cfg.supportsVideo = false
        cfg.maximumCallGroups = 1
        cfg.maximumCallsPerCallGroup = 1
        cfg.supportedHandleTypes = [.generic, .emailAddress]
        cfg.includesCallsInRecents = true
        if let iconName, let img = UIImage(named: iconName) { cfg.iconTemplateImageData = img.pngData() }
        provider = CXProvider(configuration: cfg)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    // MARK: 来电（AI 打给用户）

    /// PushKit 回调里同步调：不管票对不对都先上报来电（苹果的铁律，不报会被系统杀掉推送权限），过期的上报完立刻挂
    nonisolated func handleIncomingPush(_ p: [AnyHashable: Any], completion: @escaping () -> Void) {
        Task { @MainActor in
            let call = Call(uuid: UUID(),
                            callId: p["callId"] as? String ?? UUID().uuidString,
                            ticket: p["ticket"] as? String ?? "",
                            relayURL: p["relayURL"] as? String ?? "",
                            opener: p["opener"] as? String ?? "",
                            expiresAt: (p["expiresAt"] as? NSNumber)?.doubleValue ?? 0,
                            outgoing: false)
            self.current = call
            self.answered = false
            let update = CXCallUpdate()
            update.remoteHandle = CXHandle(type: .emailAddress, value: self.callerHandle)
            update.localizedCallerName = self.callerName
            update.hasVideo = false
            self.provider.reportNewIncomingCall(with: call.uuid, update: update) { err in
                Task { @MainActor in
                    if err != nil { self.current = nil }
                    // 推送在苹果那边压了太久、票已经过期：响一下就收
                    else if call.expiresAt > 0 && Date().timeIntervalSince1970 * 1000 > call.expiresAt {
                        self.provider.reportCall(with: call.uuid, endedAt: nil, reason: .unanswered)
                        await self.backend.reportMissed(callId: call.callId, opener: call.opener, reason: "expired")
                        self.current = nil
                    }
                    completion()
                }
            }
        }
    }

    // MARK: 去电（用户打给 AI）

    func startOutgoing() {
        guard current == nil else { delegate?.call(notice: "已经在通话里了"); return }
        let uuid = UUID()
        current = Call(uuid: uuid, callId: uuid.uuidString, ticket: "", relayURL: "", opener: "", expiresAt: 0, outgoing: true)
        answered = true
        #if targetEnvironment(simulator)
        Task { @MainActor in
            guard await self.fillTicket(uuid) else { self.end(reason: "no_ticket"); return }
            try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker])
            try? AVAudioSession.sharedInstance().setActive(true)
            self.startClient(viaCallKit: false)
            self.client?.startAudio()
        }
        #else
        let act = CXStartCallAction(call: uuid, handle: CXHandle(type: .emailAddress, value: callerHandle))
        act.isVideo = false
        controller.request(CXTransaction(action: act)) { err in
            guard let err else { return }
            Task { @MainActor in
                self.delegate?.call(notice: "拨不出去：\(err.localizedDescription)")
                if self.current?.uuid == uuid { self.end(reason: "start_refused") }
            }
        }
        #endif
    }

    private func fillTicket(_ uuid: UUID) async -> Bool {
        do {
            let t = try await backend.fetchTicket()
            guard current?.uuid == uuid else { return false }   // 等票的时候用户已经挂了
            current?.ticket = t.ticket
            current?.relayURL = t.relayURL
            return true
        } catch {
            delegate?.call(notice: "没拿到通话票：\(error.localizedDescription)")
            return false
        }
    }

    // MARK: 控制

    func hangup() {
        #if targetEnvironment(simulator)
        if let cl = client { cl.hangup(); return }
        #endif
        guard let c = current else { return }
        controller.request(CXTransaction(action: CXEndCallAction(call: c.uuid))) { _ in }
    }

    /// 静音：系统锁屏那颗和你自己的按钮都走 CallKit，两边状态才对得上
    func setMuted(_ on: Bool) {
        #if targetEnvironment(simulator)
        client?.muted = on; return
        #endif
        guard let c = current else { return }
        controller.request(CXTransaction(action: CXSetMutedCallAction(call: c.uuid, muted: on))) { _ in }
    }

    // MARK: 音频腿

    private func startClient(viaCallKit: Bool) {
        guard let c = current else { return }
        let cl = AICallClient(relayURL: c.relayURL, ticket: c.ticket, opener: c.opener, direction: c.outgoing ? "out" : "in")
        cl.onEvent = { [weak self] type, j in
            Task { @MainActor in
                guard let self else { return }
                switch type {
                case "ready":
                    if viaCallKit && c.outgoing { self.provider.reportOutgoingCall(with: c.uuid, connectedAt: Date()) }
                    self.delegate?.callDidConnect()
                case "state":
                    if let v = j["value"] as? String { self.delegate?.call(stateDidChange: v) }
                case "notice":
                    if let m = j["message"] as? String { self.delegate?.call(notice: m) }
                default: break
                }
                self.delegate?.call(didReceive: type, payload: j)
            }
        }
        cl.onEnded = { [weak self] reason in
            Task { @MainActor in
                guard let self, let cur = self.current, cur.uuid == c.uuid else { return }
                if viaCallKit { self.provider.reportCall(with: cur.uuid, endedAt: nil, reason: reason.hasPrefix("bye") ? .remoteEnded : .failed) }
                self.end(reason: reason)
            }
        }
        client = cl
        cl.connect()
        // didActivate 可能比连接建好还早，那次 startAudio 落空了，这里补上（坑：整通电话麦克风没开、一帧没发）
        if viaCallKit && audioActive { cl.startAudio() }
    }

    private func end(reason: String) {
        client = nil
        current = nil
        delegate?.callDidEnd(reason: reason)
    }

    // MARK: CXProviderDelegate

    nonisolated func providerDidReset(_ provider: CXProvider) {
        Task { @MainActor in self.client?.hangup(); self.end(reason: "reset") }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        Task { @MainActor in
            guard let cur = self.current, cur.uuid == action.callUUID else { action.fail(); return }
            self.provider.reportOutgoingCall(with: cur.uuid, startedConnectingAt: Date())
            guard await self.fillTicket(cur.uuid) else { action.fail(); self.end(reason: "no_ticket"); return }
            try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
            self.startClient(viaCallKit: true)
            let upd = CXCallUpdate()
            upd.remoteHandle = CXHandle(type: .emailAddress, value: self.callerHandle)
            upd.localizedCallerName = self.callerName
            upd.hasVideo = false
            self.provider.reportCall(with: cur.uuid, updated: upd)
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        Task { @MainActor in
            guard self.current != nil else { action.fail(); return }
            self.answered = true
            // 外放 + voiceChat：听筒只收贴耳的声音，用户对着屏幕说话电平是 0
            try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
            self.startClient(viaCallKit: true)
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor in
            let c = self.current
            let wasAnswered = self.answered
            let cl = self.client
            action.fulfill()
            if wasAnswered { cl?.hangup(); self.end(reason: "user_hung_up") }
            else if let c {
                self.end(reason: "declined")
                await self.backend.reportMissed(callId: c.callId, opener: c.opener, reason: "declined")
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor in self.client?.muted = action.isMuted; action.fulfill() }
    }

    nonisolated func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) { action.fulfill() }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        Task { @MainActor in self.audioActive = true; self.client?.startAudio() }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        Task { @MainActor in self.audioActive = false }
    }
}
