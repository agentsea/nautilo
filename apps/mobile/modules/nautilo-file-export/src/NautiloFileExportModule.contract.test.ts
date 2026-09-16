import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const moduleRoot = resolve(import.meta.dir, "..");
const read = (...parts: string[]) => readFileSync(resolve(moduleRoot, ...parts), "utf8");

test("keeps export native-only and explicit when an old client lacks the module", () => {
  const bridge = read("src", "NautiloFileExportModule.ts");
  expect(bridge).toContain("requireOptionalNativeModule");
  expect(bridge).toContain("Saving files requires an updated Nautilo native build.");
  expect(bridge).toContain("requestId: string");
  expect(bridge).toContain("cancelPendingExportAsync(requestId: string)");
  expect(bridge).toContain("prepareExportCacheAsync");
  expect(bridge).toContain("isMediaExportAvailable");
  expect(bridge).toContain('typeof nativeModule?.saveMediaAsync === "function"');
});

test("native adapters retain the destination and cancellation contracts", () => {
  const android = read("android", "src", "main", "java", "ai", "nautilo", "fileexport", "NautiloFileExportModule.kt");
  const androidContract = read("android", "src", "main", "java", "ai", "nautilo", "fileexport", "CreateDocumentContract.kt");
  const ios = read("ios", "NautiloFileExportModule.swift");

  expect(android).toContain("nautilo-exports");
  expect(androidContract).toContain("Intent.ACTION_CREATE_DOCUMENT");
  expect(androidContract).toContain("operationId = input.operationId");
  expect(android).toContain("RegisterActivityContracts");
  expect(android).toContain("CreateDocumentInput(export.operationId, filename, mimeType)");
  expect(android).toContain("cancellationRequested");
  expect(android).toContain("DocumentsContract.deleteDocument");
  expect(android).toContain("interruptPendingExport");
  expect(android).toContain("InterruptTransition.AWAIT_WRITER -> null");
  expect(android).toContain("pending !== export || export.lifecycle.cancellationRequested");
  expect(android).toContain("DestinationTransition.CANCELLED -> finishCancelledDestination(export, uri)");
  expect(android).toContain("ERR_EXPORT_WRITE_RESIDUAL");
  expect(ios).toContain("nautilo-exports");
  expect(ios).toContain("forExporting: [stagingURL], asCopy: true");
  expect(ios).toContain("cancellationRequested");
  expect(ios).toContain("ExportPickerDelegate: NSObject, UIDocumentPickerDelegate");
  expect(ios).toContain("documentPickerWasCancelled");
  expect(ios).toContain("takePending(for: export, controller: controller)");
  expect(ios).toContain("takePending(for: export)");
  expect(ios).toContain("preparation.requestID == requestID");
  expect(ios).toContain("export.requestID == requestID");
  expect(ios).toContain("interruptPendingExport");
});

test("media export is add-only and settles from the native library commit", () => {
  const android = read("android", "src", "main", "java", "ai", "nautilo", "fileexport", "NautiloFileExportModule.kt");
  const ios = read("ios", "NautiloFileExportModule.swift");

  expect(android).toContain('AsyncFunction("saveMediaAsync")');
  expect(android).toContain("MediaStore.MediaColumns.DISPLAY_NAME");
  expect(android).toContain("MediaStore.MediaColumns.MIME_TYPE");
  expect(android).toContain("MediaStore.MediaColumns.IS_PENDING");
  expect(android).toContain("resolver.update(destination");
  expect(android).toContain("contentResolver.delete(destination");
  expect(android).toContain("MediaSourceValidator.isValid");
  expect(android).toContain("WRITE_EXTERNAL_STORAGE");
  expect(android).not.toContain("READ_MEDIA_IMAGES");
  expect(android).not.toContain("READ_MEDIA_VIDEO");
  expect(android).not.toContain("READ_EXTERNAL_STORAGE");

  expect(ios).toContain("PHPhotoLibrary.requestAuthorization(for: .addOnly)");
  expect(ios).toContain("PHPhotoLibrary.shared().performChanges");
  expect(ios).toContain("options.originalFilename = export.filename");
  expect(ios).toContain("request.addResource(with: export.resourceType, fileURL: export.sourceURL");
  expect(ios).toContain("if case let .savingMedia(export)? = pending, export.commitStarted");
  expect(ios).not.toContain("PHAsset.fetchAssets");
});

// These are packaging/implementation-shape guards, not a substitute for the
// native picker and process-death acceptance recorded with the lab evidence.
test("retains startup recovery and waits for asynchronous iOS presentation", () => {
  const ios = read("ios", "NautiloFileExportModule.swift");
  const android = read("android", "src", "main", "java", "ai", "nautilo", "fileexport", "NautiloFileExportModule.kt");
  expect(ios).toContain("OnCreate { try? Self.recoverPreviousProcessFiles() }");
  expect(ios).toContain('cache.appendingPathComponent("nautilo-artifacts"');
  expect(ios).toContain('AsyncFunction("prepareExportCacheAsync")');
  expect(android).toContain('AsyncFunction("prepareExportCacheAsync")');
  expect(android).toContain('File(cache, "nautilo-artifacts")');
  expect(ios).toContain("viewController.present(picker, animated: true) {");
  expect(ios).not.toContain("picker.presentingViewController !== viewController");
});
