import AVFoundation
import ExpoModulesCore

public class NautiloVoicePcmModule: Module {
  private var engine: AVAudioEngine?
  private var player: AVAudioPlayerNode?
  private var streamId: String?
  private var submitted = 0
  private var consumed = 0
  private var finished = false
  private var observers: [NSObjectProtocol] = []
  // Same four-second window as transport credits; never buffers an entire reply.
  private let capacitySamples = 24_000 * 4
  private let startupSamples = 24_000 * 80 / 1000

  public func definition() -> ModuleDefinition {
    Name("NautiloVoicePcm")
    Events("status")
    OnCreate {
      let center = NotificationCenter.default
      for name in [AVAudioSession.interruptionNotification, AVAudioSession.routeChangeNotification,
                   UIApplication.didEnterBackgroundNotification, NSNotification.Name.AVAudioEngineConfigurationChange] {
        self.observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
          guard let self, self.streamId != nil else { return }
          if note.name == AVAudioSession.routeChangeNotification,
             let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
             reason != AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { return }
          // AppState detaches the listener on background. This is an expected
          // lifecycle stop, not a sink failure that should turn Voice Off.
          self.terminate(error: note.name == UIApplication.didEnterBackgroundNotification ? nil : "audio_interrupted")
        })
      }
    }
    AsyncFunction("begin") { (id: String) in
      self.terminate()
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
      try session.setActive(true)
      let engine = AVAudioEngine()
      let player = AVAudioPlayerNode()
      let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
      engine.attach(player)
      engine.connect(player, to: engine.mainMixerNode, format: format)
      try engine.start()
      self.engine = engine
      self.player = player
      self.streamId = id
      self.submitted = 0
      self.consumed = 0
      self.finished = false
    }.runOnQueue(.main)
    AsyncFunction("write") { (id: String, bytes: Data) in
      guard self.streamId == id, !self.finished, let player = self.player else { return }
      let count = bytes.count / 2
      guard bytes.count > 0, bytes.count % 2 == 0, bytes.count <= 48_000,
            self.submitted - self.consumed + count <= self.capacitySamples else {
        self.terminate(error: "invalid_audio")
        return
      }
      let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count))!
      buffer.frameLength = AVAudioFrameCount(count)
      bytes.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        let out = buffer.floatChannelData![0]
        for i in 0..<count {
          let bits = UInt16(raw[i * 2]) | (UInt16(raw[i * 2 + 1]) << 8)
          out[i] = Float(Int16(bitPattern: bits)) / 32768
        }
      }
      self.submitted += count
      player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
        DispatchQueue.main.async {
          guard let self, self.streamId == id else { return }
          self.consumed += count
          self.publish()
          if self.finished && self.consumed == self.submitted { self.terminate() }
        }
      }
      if !player.isPlaying && self.submitted - self.consumed >= self.startupSamples { player.play() }
      self.publish()
    }.runOnQueue(.main)
    AsyncFunction("finish") { (id: String) in
      guard self.streamId == id else { return }
      self.finished = true
      if self.submitted == self.consumed { self.publish(); self.terminate() }
      else { self.player?.play() }
    }.runOnQueue(.main)
    AsyncFunction("stop") { (id: String) in
      if self.streamId == id { self.terminate() }
    }.runOnQueue(.main)
    OnDestroy {
      for observer in self.observers { NotificationCenter.default.removeObserver(observer) }
      self.observers.removeAll()
      DispatchQueue.main.async { self.terminate() }
    }
  }

  private func publish(error: String? = nil) {
    guard let id = streamId else { return }
    var payload: [String: Any] = ["streamId": id, "consumedSamples": consumed,
      "playing": player?.isPlaying == true && consumed < submitted,
      "ended": finished && consumed == submitted]
    if let error { payload["error"] = error; payload["playing"] = false }
    sendEvent("status", payload)
  }
  private func terminate(error: String? = nil) {
    if let error { publish(error: error) }
    streamId = nil
    player?.stop()
    engine?.stop()
    player = nil
    engine = nil
  }
}
