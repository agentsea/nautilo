#!/usr/bin/env swift
// Stack 309 local iOS-Simulator acceptance helper. This is not a product
// credential path: it reads exactly one 0600 fixture, sends normal HID Unicode
// events only while the exact Simulator window is foreground, then overwrites
// and removes the fixture after successful delivery.
import ApplicationServices
import Cocoa
import Darwin
import Foundation

private let simulatorBundleIdentifier = "com.apple.iphonesimulator"
private let expectedSimulatorWindowTitles: Set<String> = [
  "iPhone 16 Pro – iOS 18.3",
  "iPhone 16 Pro Max – iOS 18.3",
]

enum FixtureField: String, Decodable {
  case handle
  case password
  case pin
}

struct Fixture: Decodable {
  let field: FixtureField
  let value: String
}

private func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(2)
}

private func parseArguments(_ argv: [String]) -> (path: String, field: FixtureField) {
  guard argv.count == 4 else {
    fail("Usage: stack309-ios-simulator-input --fixture-file <0600-path> --field handle|password|pin")
  }
  var filePath: String?
  var field: FixtureField?
  var index = 0
  while index < argv.count {
    let flag = argv[index]
    let value = argv[index + 1]
    switch flag {
    case "--fixture-file":
      guard filePath == nil, !value.isEmpty else { fail("Invalid fixture-file argument") }
      filePath = value
    case "--field":
      guard field == nil, let parsed = FixtureField(rawValue: value) else { fail("Invalid field argument") }
      field = parsed
    default:
      fail("Unsupported argument")
    }
    index += 2
  }
  guard let path = filePath, let selected = field else { fail("Missing required argument") }
  return (path, selected)
}

private func verifyPrivateRegularFile(_ path: String) -> Int32 {
  var info = stat()
  guard lstat(path, &info) == 0 else { fail("Fixture file is unavailable") }
  guard (info.st_mode & S_IFMT) == S_IFREG, (info.st_mode & 0o077) == 0, info.st_uid == geteuid() else {
    fail("Fixture file must be a current-user private regular file")
  }
  return Int32(info.st_size)
}

private func activateExactSimulator() {
  let applications = NSRunningApplication.runningApplications(withBundleIdentifier: simulatorBundleIdentifier)
  guard applications.count == 1, let simulator = applications.first,
        simulator.localizedName == "Simulator",
        simulator.activate() else {
    fail("Exact iOS Simulator could not be activated")
  }
  // Activation is asynchronous. This bounded wait permits the subsequent AX
  // check to prove that precisely the expected Simulator surface owns focus.
  Thread.sleep(forTimeInterval: 0.15)
}

private func verifyExactSimulatorFrontmostWindow() {
  guard let application = NSWorkspace.shared.frontmostApplication,
        application.bundleIdentifier == simulatorBundleIdentifier,
        application.localizedName == "Simulator" else {
    fail("Exact iOS Simulator is not frontmost")
  }
  let appElement = AXUIElementCreateApplication(application.processIdentifier)
  var focusedWindow: CFTypeRef?
  guard AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focusedWindow) == .success,
        let window = focusedWindow else {
    fail("Exact iOS Simulator window is not focused")
  }
  var titleRef: CFTypeRef?
  guard AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &titleRef) == .success,
        let title = titleRef as? String,
        expectedSimulatorWindowTitles.contains(title) else {
    fail("Unexpected iOS Simulator window")
  }
}

private func eraseAndDelete(_ path: String, byteCount: Int32) {
  guard byteCount >= 0, let handle = FileHandle(forWritingAtPath: path) else { return }
  defer { try? handle.close() }
  try? handle.write(contentsOf: Data(repeating: 0, count: Int(byteCount)))
  try? handle.synchronize()
  try? FileManager.default.removeItem(atPath: path)
}

private struct KeyStroke {
  let code: CGKeyCode
  let shift: Bool
}

private func keyStroke(for character: Character) -> KeyStroke? {
  let keyCodes: [Character: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
    "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
    "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32,
    "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    "-": 27,
  ]
  if let code = keyCodes[character] {
    return KeyStroke(code: code, shift: false)
  }
  if character == "_" {
    return KeyStroke(code: 27, shift: true)
  }
  let text = String(character)
  let lowercased = text.lowercased()
  if text != lowercased,
     lowercased.count == 1,
     let lowercaseCharacter = lowercased.first,
     let code = keyCodes[lowercaseCharacter] {
    return KeyStroke(code: code, shift: true)
  }
  return nil
}

private func sendUnicodeHidInput(_ value: String) -> Bool {
  guard !value.isEmpty, value.utf8.count <= 256,
        let source = CGEventSource(stateID: .privateState) else { return false }
  let shiftCode: CGKeyCode = 56
  guard let resetShift = CGEvent(keyboardEventSource: source, virtualKey: shiftCode, keyDown: false) else {
    return false
  }
  resetShift.post(tap: .cghidEventTap)
  // Chromium-backed hosted auth fields consume one ordinary keyboard input
  // event at a time. Posting the entire fixture as one Unicode payload can be
  // truncated to its first character even though CoreGraphics reports success.
  for character in value {
    guard let stroke = keyStroke(for: character),
          let down = CGEvent(keyboardEventSource: source, virtualKey: stroke.code, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: stroke.code, keyDown: false) else { return false }
    if stroke.shift {
      guard let shiftDown = CGEvent(keyboardEventSource: source, virtualKey: shiftCode, keyDown: true),
            let shiftUp = CGEvent(keyboardEventSource: source, virtualKey: shiftCode, keyDown: false) else {
        return false
      }
      shiftDown.post(tap: .cghidEventTap)
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
      shiftUp.post(tap: .cghidEventTap)
    } else {
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
    }
    usleep(5_000)
  }
  return true
}

let arguments = parseArguments(Array(CommandLine.arguments.dropFirst()))
let size = verifyPrivateRegularFile(arguments.path)
activateExactSimulator()
verifyExactSimulatorFrontmostWindow()
let data: Data
do {
  data = try Data(contentsOf: URL(fileURLWithPath: arguments.path), options: [.mappedIfSafe])
} catch {
  fail("Fixture file could not be read")
}
let fixture: Fixture
do {
  fixture = try JSONDecoder().decode(Fixture.self, from: data)
} catch {
  fail("Fixture file is malformed")
}
guard fixture.field == arguments.field else { fail("Fixture field does not match requested field") }
guard sendUnicodeHidInput(fixture.value) else { fail("Could not deliver input") }
eraseAndDelete(arguments.path, byteCount: size)
FileHandle.standardOutput.write(Data("Input delivered and fixture erased.\n".utf8))
