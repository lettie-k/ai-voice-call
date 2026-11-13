import Foundation
import AVFoundation

/// 通话音频的 Opus 编解码（2026-09-22）。用系统的 AudioConverter，不带第三方库。
/// 线上格式和中继 server/src/codec.mjs 一致：一条二进制消息 = [u16 BE 包长][opus 包]… ，每包 20ms（320 采样 @16k）。
/// 编码器/解码器建不出来（老系统）就返回 nil，退回 PCM。
final class AICallOpus {
    static let frame = 320
    private let pcmFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    private let opusFmt: AVAudioFormat
    private let enc: AVAudioConverter
    private let dec: AVAudioConverter
    private var pendingIn: [Float] = []

    init?() {
        guard let of = AVAudioFormat(settings: [AVFormatIDKey: kAudioFormatOpus, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1]),
              let e = AVAudioConverter(from: pcmFmt, to: of),
              let d = AVAudioConverter(from: of, to: pcmFmt) else { return nil }
        opusFmt = of
        enc = e
        dec = d
        e.bitRate = 24000
        // 试编一帧，编不出来就当不支持
        let probe = [Float](repeating: 0, count: AICallOpus.frame)
        if encodeFrame(probe) == nil { return nil }
    }

    /// 喂任意长度的 16k float 采样，返回编好的包（每 320 采样一包）
    func encode(_ samples: [Float]) -> [Data] {
        pendingIn.append(contentsOf: samples)
        var out: [Data] = []
        while pendingIn.count >= AICallOpus.frame {
            let f = Array(pendingIn[0..<AICallOpus.frame])
            pendingIn.removeFirst(AICallOpus.frame)
            if let p = encodeFrame(f) { out.append(p) }
        }
        return out
    }

    private func encodeFrame(_ f: [Float]) -> Data? {
        guard let inBuf = AVAudioPCMBuffer(pcmFormat: pcmFmt, frameCapacity: AVAudioFrameCount(f.count)) else { return nil }
        inBuf.frameLength = AVAudioFrameCount(f.count)
        f.withUnsafeBufferPointer { inBuf.floatChannelData![0].update(from: $0.baseAddress!, count: f.count) }
        let outBuf = AVAudioCompressedBuffer(format: opusFmt, packetCapacity: 4, maximumPacketSize: max(enc.maximumOutputPacketSize, 400))
        var fed = false
        var err: NSError?
        let status = enc.convert(to: outBuf, error: &err) { _, st in
            if fed { st.pointee = .noDataNow; return nil }
            fed = true; st.pointee = .haveData; return inBuf
        }
        guard err == nil, status != .error, outBuf.packetCount > 0, let desc = outBuf.packetDescriptions else { return nil }
        let d = desc[0]
        return Data(bytes: outBuf.data.advanced(by: Int(d.mStartOffset)), count: Int(d.mDataByteSize))
    }

    /// 一条下行消息 → 16k float 采样
    func decodeMessage(_ msg: Data) -> [Float] {
        var out: [Float] = []
        var i = 0
        let n = msg.count
        while i + 2 <= n {
            let len = Int(msg[i]) << 8 | Int(msg[i + 1]); i += 2
            guard len > 0, i + len <= n else { break }
            if let s = decodePacket(msg.subdata(in: i..<(i + len))) { out.append(contentsOf: s) }
            i += len
        }
        return out
    }

    private func decodePacket(_ p: Data) -> [Float]? {
        let inBuf = AVAudioCompressedBuffer(format: opusFmt, packetCapacity: 1, maximumPacketSize: max(p.count, 1))
        p.withUnsafeBytes { raw in inBuf.data.copyMemory(from: raw.baseAddress!, byteCount: p.count) }
        inBuf.byteLength = UInt32(p.count)
        inBuf.packetCount = 1
        inBuf.packetDescriptions?[0] = AudioStreamPacketDescription(mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(p.count))
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: pcmFmt, frameCapacity: 1920) else { return nil }
        var fed = false
        var err: NSError?
        let status = dec.convert(to: outBuf, error: &err) { _, st in
            if fed { st.pointee = .noDataNow; return nil }
            fed = true; st.pointee = .haveData; return inBuf
        }
        guard err == nil, status != .error, outBuf.frameLength > 0 else { return nil }
        return Array(UnsafeBufferPointer(start: outBuf.floatChannelData![0], count: Int(outBuf.frameLength)))
    }
}
