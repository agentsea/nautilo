import ExpoModulesCore
import Photos
import UIKit

private struct SaveFileInput: Record {
  @Field var requestId: String
  @Field var fileUri: String
  @Field var filename: String
  @Field var mimeType: String
}

/**
 * A narrow export boundary: only a regular, resolved file inside Caches can
 * leave the app, and only after the user chooses a destination in Files.
 */
public class NautiloFileExportModule: Module {
  // Once per OS process, not per React mount/reload: a new JS bridge must not
  // sweep a still-dismissing export owned by the previous bridge.
  private static let recoveryLock = NSLock()
  private static var recoveredCache = false
  private final class PendingExport {
    let requestID: String
    let promise: Promise
    let stagingURL: URL
    var cancellationRequested = false
    var picker: UIDocumentPickerViewController?
    var pickerDelegate: ExportPickerDelegate?

    init(requestID: String, promise: Promise, stagingURL: URL) {
      self.requestID = requestID
      self.promise = promise
      self.stagingURL = stagingURL
    }
  }

  private final class PreparingExport {
    let requestID: String
    let promise: Promise
    var cancellationRequested = false

    init(requestID: String, promise: Promise) {
      self.requestID = requestID
      self.promise = promise
    }
  }

  private final class PendingMediaExport {
    let requestID: String
    let promise: Promise
    let sourceURL: URL
    let filename: String
    let resourceType: PHAssetResourceType
    var cancellationRequested = false
    var commitStarted = false

    init(requestID: String, promise: Promise, sourceURL: URL, filename: String, resourceType: PHAssetResourceType) {
      self.requestID = requestID
      self.promise = promise
      self.sourceURL = sourceURL
      self.filename = filename
      self.resourceType = resourceType
    }
  }

  // UIDocumentPickerDelegate inherits NSObjectProtocol, whereas an Expo Module
  // is a BaseModule. This per-export object also keeps old picker callbacks
  // bound to their original operation without retaining its module or export.
  private final class ExportPickerDelegate: NSObject, UIDocumentPickerDelegate {
    weak var module: NautiloFileExportModule?
    weak var export: PendingExport?

    init(module: NautiloFileExportModule, export: PendingExport) {
      self.module = module
      self.export = export
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
      guard let module, let export else { return }
      module.finishCancelled(for: export, controller: controller)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
      // A completion is the only confirmation that the Files copy happened.
      guard let module, let export else { return }
      module.finishSaved(for: export, controller: controller)
    }
  }

  private enum PendingState {
    case preparing(PreparingExport)
    case presenting(PendingExport)
    case savingMedia(PendingMediaExport)
  }

  private enum Installation {
    case installed
    case cancelled
    case inactive
  }

  private enum StagingError: Error { case cleanupFailed }

  private let stateQueue = DispatchQueue(label: "ai.nautilo.fileexport.state")
  private var pending: PendingState?

  public func definition() -> ModuleDefinition {
    Name("NautiloFileExport")

    OnCreate { try? Self.recoverPreviousProcessFiles() }

    AsyncFunction("prepareExportCacheAsync") { (promise: Promise) in
      do {
        try Self.recoverPreviousProcessFiles()
        promise.resolve(nil)
      } catch {
        promise.reject("ERR_EXPORT_CACHE_CLEANUP", "Temporary app copies could not be removed.")
      }
    }

    AsyncFunction("saveFileAsync") { (input: SaveFileInput, promise: Promise) in
      guard let source = self.trustedCacheFile(input.fileUri),
            !input.requestId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            let filename = self.safeFilename(input.filename),
            self.validMimeType(input.mimeType) else {
        promise.reject("ERR_EXPORT_SOURCE", "The requested file is unavailable.")
        return
      }

      guard let preparation = self.reserve(input.requestId, promise: promise) else {
        promise.reject("ERR_EXPORT_BUSY", "Another file export is already in progress.")
        return
      }

      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let stagingURL = try self.makeStagingCopy(source: source, filename: filename)
          let export = PendingExport(requestID: input.requestId, promise: promise, stagingURL: stagingURL)
          switch self.install(preparation, export: export) {
          case .installed:
            break
          case .cancelled:
            if self.cleanup(stagingURL) { promise.resolve(["status": "cancelled"]) }
            else { promise.reject("ERR_EXPORT_CANCELLED_CACHE_RESIDUAL", "A temporary app copy could not be removed.") }
            return
          case .inactive:
            self.cleanup(stagingURL)
            return
          }
          DispatchQueue.main.async {
            guard self.shouldPresent(export) else {
              self.finishCancelled(for: export)
              return
            }
            guard let viewController = self.appContext?.utilities?.currentViewController(),
                  UIApplication.shared.applicationState == .active,
                  viewController.viewIfLoaded?.window != nil,
                  !viewController.isBeingDismissed, !viewController.isBeingPresented,
                  viewController.presentedViewController == nil else {
              self.finishFailure(for: export, code: "ERR_EXPORT_ACTIVITY", message: "A file destination is unavailable right now.")
              return
            }
            let picker = UIDocumentPickerViewController(forExporting: [stagingURL], asCopy: true)
            let delegate = ExportPickerDelegate(module: self, export: export)
            picker.delegate = delegate
            export.picker = picker
            export.pickerDelegate = delegate
            guard self.shouldPresent(export) else {
              self.finishCancelled(for: export)
              return
            }
            viewController.present(picker, animated: true) {
              // Presentation is asynchronous and may be forwarded to an
              // ancestor. Never delete Files' source based on the immediate
              // post-present relationship. Known refusal conditions are
              // checked above; this callback checks completed presentation.
              if picker.presentingViewController == nil {
                self.finishFailure(for: export, code: "ERR_EXPORT_ACTIVITY", message: "A file destination is unavailable right now.")
              }
            }
          }
        } catch {
          if error is StagingError {
            self.finishFailure(for: preparation, code: "ERR_EXPORT_CACHE_CLEANUP", message: "Temporary app copies could not be removed.")
          } else {
            self.finishFailure(for: preparation, code: "ERR_EXPORT_PREPARE", message: "The file could not be prepared for export.")
          }
        }
      }
    }

    AsyncFunction("saveMediaAsync") { (input: SaveFileInput, promise: Promise) in
      guard let source = self.trustedCacheFile(input.fileUri),
            !input.requestId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            let filename = self.safeFilename(input.filename),
            self.validMimeType(input.mimeType),
            let resourceType = self.mediaResourceType(input.mimeType) else {
        promise.reject("ERR_MEDIA_SOURCE", "The requested photo or video is unavailable.")
        return
      }
      let export = PendingMediaExport(
        requestID: input.requestId,
        promise: promise,
        sourceURL: source,
        filename: filename,
        resourceType: resourceType
      )
      guard self.reserveMedia(export) else {
        promise.reject("ERR_EXPORT_BUSY", "Another file export is already in progress.")
        return
      }
      PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
        guard self.isActive(export) else { return }
        switch status {
        case .authorized, .limited:
          self.commitMedia(export)
        case .denied, .restricted:
          self.finishMediaFailure(export, code: "ERR_MEDIA_PERMISSION", message: "Photos access is required to save this item.")
        case .notDetermined:
          self.finishMediaFailure(export, code: "ERR_MEDIA_PERMISSION", message: "Photos access was not granted.")
        @unknown default:
          self.finishMediaFailure(export, code: "ERR_MEDIA_PERMISSION", message: "Photos access is unavailable.")
        }
      }
    }

    // Ask an uncompleted picker to dismiss. Its actual callback/completion is
    // still the final receipt; a completed user-owned copy is never retracted.
    AsyncFunction("cancelPendingExportAsync") { (requestID: String) -> Bool in
      let cancellation: (matched: Bool, export: PendingExport?, picker: UIDocumentPickerViewController?, media: PendingMediaExport?) = self.stateQueue.sync {
        switch self.pending {
        case let .preparing(preparation) where preparation.requestID == requestID:
          preparation.cancellationRequested = true
          return (true, nil, nil, nil)
        case let .presenting(export) where export.requestID == requestID:
          export.cancellationRequested = true
          return (true, export, export.picker, nil)
        case let .savingMedia(export) where export.requestID == requestID:
          export.cancellationRequested = true
          if !export.commitStarted {
            self.pending = nil
            return (true, nil, nil, export)
          }
          return (true, nil, nil, nil)
        default:
          return (false, nil, nil, nil)
        }
      }
      guard cancellation.matched else { return false }
      cancellation.media?.promise.resolve(["status": "cancelled"])
      if let export = cancellation.export, let picker = cancellation.picker {
        DispatchQueue.main.async {
          picker.dismiss(animated: true) {
            self.finishCancelled(for: export)
          }
        }
      }
      return true
    }

    OnDestroy {
      self.interruptPendingExport()
    }
  }

  private func reserve(_ requestID: String, promise: Promise) -> PreparingExport? {
    stateQueue.sync {
      guard pending == nil else { return nil }
      // A marker prevents another picker while the staging file is prepared.
      let preparation = PreparingExport(requestID: requestID, promise: promise)
      pending = .preparing(preparation)
      return preparation
    }
  }

  private func reserveMedia(_ export: PendingMediaExport) -> Bool {
    stateQueue.sync {
      guard pending == nil else { return false }
      pending = .savingMedia(export)
      return true
    }
  }

  private func isActive(_ export: PendingMediaExport) -> Bool {
    stateQueue.sync {
      guard case let .savingMedia(current)? = pending else { return false }
      return current === export && !current.cancellationRequested
    }
  }

  private func beginMediaCommit(_ export: PendingMediaExport) -> Bool {
    stateQueue.sync {
      guard case let .savingMedia(current)? = pending,
            current === export, !current.cancellationRequested, !current.commitStarted else { return false }
      current.commitStarted = true
      return true
    }
  }

  private func takePendingMedia(_ export: PendingMediaExport) -> PendingMediaExport? {
    stateQueue.sync {
      guard case let .savingMedia(current)? = pending, current === export else { return nil }
      pending = nil
      return current
    }
  }

  private func commitMedia(_ export: PendingMediaExport) {
    guard beginMediaCommit(export) else { return }
    PHPhotoLibrary.shared().performChanges {
      let request = PHAssetCreationRequest.forAsset()
      let options = PHAssetResourceCreationOptions()
      options.originalFilename = export.filename
      request.addResource(with: export.resourceType, fileURL: export.sourceURL, options: options)
    } completionHandler: { success, _ in
      guard let active = self.takePendingMedia(export) else { return }
      if success {
        // PhotoKit has committed the user-owned item. A cancellation racing
        // after commit began cannot retract it under add-only authorization.
        active.promise.resolve(["status": "saved"])
      } else {
        active.promise.reject("ERR_MEDIA_SAVE", "The photo or video could not be saved.")
      }
    }
  }

  private func finishMediaFailure(_ export: PendingMediaExport, code: String, message: String) {
    guard let active = takePendingMedia(export) else { return }
    active.promise.reject(code, message)
  }

  private func install(_ preparation: PreparingExport, export: PendingExport) -> Installation {
    stateQueue.sync {
      guard case let .preparing(current)? = pending, current === preparation else { return .inactive }
      if current.cancellationRequested {
        pending = nil
        return .cancelled
      }
      pending = .presenting(export)
      return .installed
    }
  }

  private func takePending(for export: PendingExport) -> PendingExport? {
    stateQueue.sync {
      guard case let .presenting(current)? = pending, current === export else { return nil }
      pending = nil
      return current
    }
  }

  private func takePending(for export: PendingExport, controller: UIDocumentPickerViewController) -> PendingExport? {
    stateQueue.sync {
      guard case let .presenting(current)? = pending,
            current === export,
            current.picker === controller else { return nil }
      pending = nil
      return current
    }
  }

  private func shouldPresent(_ export: PendingExport) -> Bool {
    stateQueue.sync {
      guard case let .presenting(current)? = pending, current === export else { return false }
      return !current.cancellationRequested
    }
  }

  private func finishSaved(for export: PendingExport, controller: UIDocumentPickerViewController) {
    guard let export = takePending(for: export, controller: controller) else { return }
    if cleanup(export.stagingURL) { export.promise.resolve(["status": "saved"]) }
    else { export.promise.reject("ERR_EXPORT_SAVED_RESIDUAL", "The file was saved, but a temporary app copy could not be removed.") }
  }

  private func finishCancelled(for export: PendingExport, controller: UIDocumentPickerViewController) {
    guard let export = takePending(for: export, controller: controller) else { return }
    if cleanup(export.stagingURL) { export.promise.resolve(["status": "cancelled"]) }
    else { export.promise.reject("ERR_EXPORT_CANCELLED_CACHE_RESIDUAL", "A temporary app copy could not be removed.") }
  }

  private func finishCancelled(for export: PendingExport) {
    guard let export = takePending(for: export) else { return }
    if cleanup(export.stagingURL) { export.promise.resolve(["status": "cancelled"]) }
    else { export.promise.reject("ERR_EXPORT_CANCELLED_CACHE_RESIDUAL", "A temporary app copy could not be removed.") }
  }

  private func finishFailure(for preparation: PreparingExport, code: String, message: String) {
    let active = stateQueue.sync { () -> Bool in
      guard case let .preparing(current)? = pending, current === preparation else { return false }
      pending = nil
      return true
    }
    if active { preparation.promise.reject(code, message) }
  }

  private func finishFailure(for export: PendingExport, code: String, message: String) {
    guard let export = takePending(for: export) else { return }
    if cleanup(export.stagingURL) { export.promise.reject(code, message) }
    else { export.promise.reject("ERR_EXPORT_CACHE_CLEANUP", "Temporary app copies could not be removed.") }
  }

  private func interruptPendingExport() {
    let state = stateQueue.sync { () -> PendingState? in
      // PhotoKit may still be reading sourceURL after performChanges returns.
      // Once its atomic commit starts, keep the operation and source ownership
      // alive until PhotoKit's completion callback is the terminal receipt.
      if case let .savingMedia(export)? = pending, export.commitStarted {
        export.cancellationRequested = true
        return nil
      }
      let current = pending
      pending = nil
      return current
    }
    switch state {
    case let .presenting(export):
      // The operation is already detached, so every later delegate callback is
      // a no-op even if a new export has started. Dismissal cannot retract a
      // completed Files copy; it only closes a still-presenting picker.
      if let picker = export.picker {
        DispatchQueue.main.async {
          picker.dismiss(animated: true) {
            self.cleanup(export.stagingURL)
          }
        }
      } else {
        cleanup(export.stagingURL)
      }
      export.promise.reject("ERR_EXPORT_INTERRUPTED", "The file export was interrupted.")
    case let .preparing(preparation):
      preparation.promise.reject("ERR_EXPORT_INTERRUPTED", "The file export was interrupted.")
    case let .savingMedia(export):
      export.promise.reject("ERR_EXPORT_INTERRUPTED", "The media export was interrupted.")
    case nil:
      return
    }
  }

  @discardableResult
  private func cleanup(_ stagingURL: URL) -> Bool {
    let directory = stagingURL.deletingLastPathComponent()
    guard FileManager.default.fileExists(atPath: directory.path) else { return true }
    do { try FileManager.default.removeItem(at: directory); return true }
    catch { return false }
  }

  private static func recoverPreviousProcessFiles() throws {
    recoveryLock.lock()
    defer { recoveryLock.unlock() }
    guard !recoveredCache else { return }
    let manager = FileManager.default
    let cache = manager.urls(for: .cachesDirectory, in: .userDomainMask)[0].resolvingSymlinksInPath()
    let roots = [
      cache.appendingPathComponent("nautilo-exports", isDirectory: true),
      cache.appendingPathComponent("nautilo-artifacts", isDirectory: true),
      manager.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("NautiloFileExport", isDirectory: true),
    ]
    for root in roots where manager.fileExists(atPath: root.path) {
      guard root.standardizedFileURL == root.resolvingSymlinksInPath().standardizedFileURL else {
        throw NSError(domain: "NautiloFileExport", code: 1)
      }
      // Only this module's generated UUID children; unknown neighboring files
      // are never candidates. removeItem unlinks symbolic links, not targets.
      for child in try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
        guard UUID(uuidString: child.lastPathComponent) != nil else { continue }
        try manager.removeItem(at: child)
      }
    }
    recoveredCache = true
  }

  private func trustedCacheFile(_ rawURI: String) -> URL? {
    guard let url = URL(string: rawURI), url.isFileURL else { return nil }
    let resolved = url.resolvingSymlinksInPath().standardizedFileURL
    let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("nautilo-exports", isDirectory: true)
      .resolvingSymlinksInPath().standardizedFileURL
    guard resolved.path.hasPrefix(cache.path + "/"),
          let values = try? resolved.resourceValues(forKeys: [.isRegularFileKey]),
          values.isRegularFile == true else { return nil }
    return resolved
  }

  private func safeFilename(_ raw: String?) -> String? {
    guard let name = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
          !name.isEmpty, name != ".", name != "..",
          !name.contains("/"), !name.contains("\\"),
          !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
      return nil
    }
    return name
  }

  private func validMimeType(_ value: String) -> Bool {
    value.range(of: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$", options: .regularExpression) != nil
  }

  private func mediaResourceType(_ mimeType: String) -> PHAssetResourceType? {
    if mimeType.lowercased().hasPrefix("image/") { return .photo }
    if mimeType.lowercased().hasPrefix("video/") { return .video }
    return nil
  }

  private func makeStagingCopy(source: URL, filename: String) throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("NautiloFileExport", isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    do {
      let destination = directory.appendingPathComponent(filename, isDirectory: false)
      try FileManager.default.copyItem(at: source, to: destination)
      return destination
    } catch {
      do { try FileManager.default.removeItem(at: directory) }
      catch { throw StagingError.cleanupFailed }
      throw error
    }
  }
}
