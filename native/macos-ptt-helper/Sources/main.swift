import AppKit
import AVFoundation
import Darwin
import Foundation
import Speech

@MainActor
final class PushToTalkHotkey {
  private var globalMonitor: Any?
  private var localMonitor: Any?
  private var optionDown = false
  private var active = false
  private var pollTimer: Timer?
  private var parentMonitorTimer: Timer?
  private let parentPID: Int32?
  private let allowedFrontmostApp: String?
  private let lockPath: String?

  init() {
    let env = ProcessInfo.processInfo.environment
    if let raw = env["NAUTILO_PTT_PARENT_PID"], let pid = Int32(raw) {
      self.parentPID = pid
    } else {
      self.parentPID = nil
    }
    let app = env["NAUTILO_PTT_ALLOWED_APP"]?.trimmingCharacters(in: .whitespacesAndNewlines)
    self.allowedFrontmostApp = app?.isEmpty == false ? app : nil
    let lockPath = env["NAUTILO_PTT_LOCK_PATH"]?.trimmingCharacters(in: .whitespacesAndNewlines)
    self.lockPath = lockPath?.isEmpty == false ? lockPath : nil
  }

  func start() -> Bool {
    guard globalMonitor == nil, localMonitor == nil else { return true }
    startParentMonitor()

    if AXIsProcessTrusted() {
      return installMonitors()
    }

    fputs("PERMISSION\tACCESSIBILITY\n", stderr)
    fflush(stderr)

    pollTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in
      if AXIsProcessTrusted() {
        DispatchQueue.main.async { [weak self] in
          guard let self else { return }
          self.pollTimer?.invalidate()
          self.pollTimer = nil
          if self.installMonitors() {
            fputs("STATUS\tREADY\n", stderr)
            fflush(stderr)
          }
        }
      }
    }

    return false

  }

  private func startParentMonitor() {
    guard parentMonitorTimer == nil, let parentPID else { return }
    parentMonitorTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
      DispatchQueue.main.async {
        guard let self else {
          return
        }
        if !self.parentIsAlive(parentPID) {
          self.parentMonitorTimer?.invalidate()
          self.parentMonitorTimer = nil
          self.cleanupLockFile()
          NSApp.terminate(nil)
        }
      }
    }
  }

  private func parentIsAlive(_ pid: Int32) -> Bool {
    if pid <= 1 { return false }
    let result = kill(pid, 0)
    if result == 0 { return true }
    return errno == EPERM
  }

  private func frontmostAppIsAllowed() -> Bool {
    guard let allowedFrontmostApp else { return true }
    let activeName = NSWorkspace.shared.frontmostApplication?.localizedName?.trimmingCharacters(in: .whitespacesAndNewlines)
    return activeName == allowedFrontmostApp
  }

  private func cleanupLockFile() {
    guard let lockPath else { return }
    try? FileManager.default.removeItem(atPath: lockPath)
  }

  func openAccessibilitySettings() {
    let promptKey = "AXTrustedCheckOptionPrompt" as CFString
    let opts = [promptKey: kCFBooleanTrue!] as CFDictionary
    AXIsProcessTrustedWithOptions(opts)

    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
      NSWorkspace.shared.open(url)
    }
  }

  private func installMonitors() -> Bool {
    globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
      self?.handle(event: event)
    }

    localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
      self?.handle(event: event)
      return event
    }

    if globalMonitor == nil {
      fputs("PERMISSION\tACCESSIBILITY\n", stderr)
      fflush(stderr)
      return false
    }
    return true
  }

  private func handle(event: NSEvent) {
    if !frontmostAppIsAllowed() {
      if active {
        active = false
        fputs("STATUS\tIDLE\n", stderr)
        fflush(stderr)
      }
      return
    }

    optionDown = event.modifierFlags.contains(.option)

    let chordActive = optionDown
    if chordActive, !active {
      active = true
      fputs("STATUS\tLISTENING\n", stderr)
      fflush(stderr)
      Task { await PushToTalkRuntime.shared.begin() }
    } else if !chordActive, active {
      active = false
      fputs("STATUS\tPROCESSING\n", stderr)
      fflush(stderr)
      Task { await PushToTalkRuntime.shared.end() }
    }
  }
}

actor PushToTalkRuntime {
  static let shared = PushToTalkRuntime()

  private var recognizer: SFSpeechRecognizer?
  private var audioEngine: AVAudioEngine?
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var isCapturing = false
  private var transcript = ""
  private var finalizeTask: Task<Void, Never>?
  private var didFinalize = false

  func begin() async {
    guard !isCapturing else { return }
    guard await permissionsGranted() else { return }

    isCapturing = true
    transcript = ""
    didFinalize = false
    finalizeTask?.cancel()
    finalizeTask = nil

    do {
      try startRecognition()
    } catch {
      isCapturing = false
      fputs("ERROR\t\(error.localizedDescription)\n", stderr)
      fflush(stderr)
    }
  }

  func end() async {
    guard isCapturing else { return }
    isCapturing = false

    recognitionRequest?.endAudio()
    audioEngine?.inputNode.removeTap(onBus: 0)
    audioEngine?.stop()

    finalizeTask?.cancel()
    finalizeTask = Task {
      try? await Task.sleep(for: .milliseconds(1200))
      await finalizeTranscript()
    }
  }

  private func startRecognition() throws {
    recognizer = SFSpeechRecognizer(locale: Locale(identifier: Locale.current.identifier))
    guard let recognizer, recognizer.isAvailable else {
      throw NSError(domain: "NautiloPTT", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "Speech recognizer unavailable for locale \(Locale.current.identifier)"
      ])
    }

    if audioEngine == nil {
      audioEngine = AVAudioEngine()
    }
    guard let audioEngine else {
      throw NSError(domain: "NautiloPTT", code: 2, userInfo: [
        NSLocalizedDescriptionKey: "Audio engine unavailable"
      ])
    }

    recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
    guard let recognitionRequest else {
      throw NSError(domain: "NautiloPTT", code: 3, userInfo: [
        NSLocalizedDescriptionKey: "Could not create recognition request"
      ])
    }
    recognitionRequest.shouldReportPartialResults = true

    let input = audioEngine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak recognitionRequest] buffer, _ in
      recognitionRequest?.append(buffer)
    }

    recognitionTask?.cancel()
    recognitionTask = recognizer.recognitionTask(with: recognitionRequest) { [weak self] result, error in
      guard let self else { return }
      let transcript = result?.bestTranscription.formattedString ?? ""
      let isFinal = result?.isFinal ?? false
      let hadError = error != nil
      Task {
        if !transcript.isEmpty {
          await self.updateTranscript(transcript, isFinal: isFinal)
        }
        if hadError {
          await self.finalizeTranscript()
        }
      }
    }

    audioEngine.prepare()
    try audioEngine.start()
  }

  private func updateTranscript(_ text: String, isFinal: Bool) async {
    transcript = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if isFinal {
      await finalizeTranscript()
    }
  }

  private func finalizeTranscript() async {
    guard !didFinalize else { return }
    didFinalize = true

    finalizeTask?.cancel()
    finalizeTask = nil

    recognitionTask?.cancel()
    recognitionTask = nil
    recognitionRequest = nil
    audioEngine?.inputNode.removeTap(onBus: 0)
    audioEngine?.stop()

    let finalText = transcript
      .replacingOccurrences(of: "\n", with: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines)

    if !finalText.isEmpty {
      print("TRANSCRIPT\t\(finalText)")
      fflush(stdout)
      fputs("STATUS\tIDLE\n", stderr)
      fflush(stderr)
    } else {
      fputs("STATUS\tEMPTY\n", stderr)
      fflush(stderr)
    }
  }

  private func permissionsGranted() async -> Bool {
    let speechStatus = await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { status in
        continuation.resume(returning: status)
      }
    }

    let micGranted = await withCheckedContinuation { continuation in
      AVCaptureDevice.requestAccess(for: .audio) { granted in
        continuation.resume(returning: granted)
      }
    }

    if speechStatus != .authorized {
      fputs("PERMISSION\tSPEECH\n", stderr)
      fflush(stderr)
      if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition") {
        NSWorkspace.shared.open(url)
      }
    }
    if !micGranted {
      fputs("PERMISSION\tMICROPHONE\n", stderr)
      fflush(stderr)
      if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
        NSWorkspace.shared.open(url)
      }
    }

    return speechStatus == .authorized && micGranted
  }
}

@main
struct NautiloPTTHelper {
  @MainActor
  static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)

    let hotkey = PushToTalkHotkey()
    let started = hotkey.start()

    if started {
      fputs("STATUS\tREADY\n", stderr)
      fflush(stderr)
    } else {
      fputs("STATUS\tWAITING_FOR_PERMISSION\n", stderr)
      fflush(stderr)
    }

    app.run()
  }
}
