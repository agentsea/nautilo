import ExpoModulesCore

public class NautiloShareHandoffModule: Module {
  private let suiteName = "group.ai.nautilo.app.share"
  private let payloadKey = "ai.nautilo.share.pending-v1"
  private let filePayloadKey = "ai.nautilo.share.pending-file-v1"
  private let fileInboxDirectory = "NautiloShareHandoff"
  private let maxInboundFileBytes: Int64 = 100 * 1024 * 1024
  private let maxInboundFileAge: TimeInterval = 10 * 60

  public func definition() -> ModuleDefinition {
    Name("NautiloShareHandoff")

    AsyncFunction("peekAsync") { () -> [String: Any]? in
      guard let defaults = UserDefaults(suiteName: suiteName) else {
        return nil
      }
      return defaults.dictionary(forKey: payloadKey)
    }

    AsyncFunction("ackAsync") { (id: String) -> Bool in
      guard let defaults = UserDefaults(suiteName: suiteName),
            let record = defaults.dictionary(forKey: payloadKey),
            record["id"] as? String == id else {
        return false
      }
      defaults.removeObject(forKey: payloadKey)
      return true
    }

    AsyncFunction("clearAsync") { () in
      UserDefaults(suiteName: suiteName)?.removeObject(forKey: payloadKey)
    }

    AsyncFunction("peekInboundFileAsync") { () -> [String: Any]? in
      guard let defaults = UserDefaults(suiteName: suiteName) else { return nil }
      cleanExpiredInboundFiles(defaults: defaults)
      guard let record = defaults.dictionary(forKey: filePayloadKey),
            let id = record["id"] as? String,
            let nativeReceiptId = record["nativeReceiptId"] as? String,
            let filename = record["filename"] as? String,
            let mimeType = record["mimeType"] as? String,
            let size = record["sizeBytes"] as? NSNumber,
            let createdAt = record["createdAt"] as? String,
            validInboundReceipt(
              id: id,
              nativeReceiptId: nativeReceiptId,
              filename: filename,
              mimeType: mimeType,
              sizeBytes: size.int64Value,
              createdAt: createdAt
            ),
            let file = inboundFile(nativeReceiptId),
            inboundFileSize(file) == size.int64Value else {
        defaults.removeObject(forKey: filePayloadKey)
        return nil
      }
      return [
        "id": id,
        "nativeReceiptId": nativeReceiptId,
        "filename": filename,
        "mimeType": mimeType,
        "sizeBytes": size,
        "createdAt": createdAt,
      ]
    }

    // The protected App Group URL is returned only for one explicit upload.
    // It never enters persisted JS metadata, drafts, navigation, or logs.
    AsyncFunction("openInboundFileAsync") { (nativeReceiptId: String) -> [String: Any]? in
      guard validOpaqueId(nativeReceiptId),
            let file = inboundFile(nativeReceiptId) else { return nil }
      let size = inboundFileSize(file)
      guard size > 0 && size <= maxInboundFileBytes else { return nil }
      return ["contentUri": file.absoluteString]
    }

    // Ack removes only the one pending metadata handoff. The protected bytes
    // remain available by opaque receipt until explicit send/discard/expiry.
    AsyncFunction("ackInboundFileAsync") { (id: String) -> Bool in
      guard let defaults = UserDefaults(suiteName: suiteName),
            let record = defaults.dictionary(forKey: filePayloadKey),
            record["id"] as? String == id else { return false }
      defaults.removeObject(forKey: filePayloadKey)
      return true
    }

    AsyncFunction("discardInboundFileAsync") { (nativeReceiptId: String) -> Bool in
      guard validOpaqueId(nativeReceiptId) else { return false }
      let defaults = UserDefaults(suiteName: suiteName)
      if let record = defaults?.dictionary(forKey: filePayloadKey),
         record["nativeReceiptId"] as? String == nativeReceiptId {
        defaults?.removeObject(forKey: filePayloadKey)
      }
      guard let file = inboundFile(nativeReceiptId) else { return false }
      do {
        try FileManager.default.removeItem(at: file)
        return true
      } catch {
        return false
      }
    }
  }

  private func validOpaqueId(_ value: String) -> Bool {
    value.range(of: "^[a-zA-Z0-9-]{8,80}$", options: .regularExpression) != nil
  }

  private func appGroupContainer() -> URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: suiteName)
  }

  private func inboundInbox() -> URL? {
    appGroupContainer()?.appendingPathComponent(fileInboxDirectory, isDirectory: true)
  }

  private func inboundFile(_ nativeReceiptId: String) -> URL? {
    guard validOpaqueId(nativeReceiptId) else { return nil }
    return inboundInbox()?.appendingPathComponent(nativeReceiptId, isDirectory: false)
  }

  private func inboundFileSize(_ url: URL) -> Int64 {
    guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
          values.isRegularFile == true,
          let size = values.fileSize else { return -1 }
    return Int64(size)
  }

  private func validInboundReceipt(
    id: String,
    nativeReceiptId: String,
    filename: String,
    mimeType: String,
    sizeBytes: Int64,
    createdAt: String
  ) -> Bool {
    guard validOpaqueId(id), validOpaqueId(nativeReceiptId),
          !filename.isEmpty, filename.count <= 255,
          mimeType.range(of: "^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$", options: .regularExpression) != nil,
          sizeBytes > 0, sizeBytes <= maxInboundFileBytes,
          let date = ISO8601DateFormatter().date(from: createdAt) else { return false }
    let age = Date().timeIntervalSince(date)
    return age >= -60 && age <= maxInboundFileAge
  }

  private func cleanExpiredInboundFiles(defaults: UserDefaults) {
    let cutoff = Date().addingTimeInterval(-maxInboundFileAge)
    if let inbox = inboundInbox(),
       let files = try? FileManager.default.contentsOfDirectory(
         at: inbox,
         includingPropertiesForKeys: [.contentModificationDateKey],
         options: [.skipsHiddenFiles]
       ) {
      for file in files {
        let modified = try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        if modified == nil || modified! < cutoff { try? FileManager.default.removeItem(at: file) }
      }
    }
    if let record = defaults.dictionary(forKey: filePayloadKey),
       let createdAt = record["createdAt"] as? String,
       let date = ISO8601DateFormatter().date(from: createdAt),
       date < cutoff {
      defaults.removeObject(forKey: filePayloadKey)
    }
  }
}
