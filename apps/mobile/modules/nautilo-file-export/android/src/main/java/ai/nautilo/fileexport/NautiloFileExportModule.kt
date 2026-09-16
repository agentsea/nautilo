package ai.nautilo.fileexport

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.DocumentsContract
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.io.IOException

/**
 * Deliberately narrow user-export boundary. It accepts only a regular file
 * already under this application's cache directory, then lets the OS choose
 * the destination. It does not expose a general filesystem API to JS.
 */
class NautiloFileExportModule : Module() {
  companion object {
    private val MIME_TYPE = Regex("^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$")
    private val recoveryLock = Any()
    private var recoveredCache = false

    // OS-process lifetime, not React module lifetime: reloading JS must never
    // scavenge a source still owned by a previous module's terminating copy.
    private fun recoverPreviousProcessFiles(context: Context) = synchronized(recoveryLock) {
      if (!recoveredCache) {
        val cache = context.cacheDir.canonicalFile
        ExportCacheRecovery.sweep(File(cache, "nautilo-exports"))
        ExportCacheRecovery.sweep(File(cache, "nautilo-artifacts"))
        recoveredCache = true
      }
    }
  }

  private data class PendingExport(
    val source: File,
    val promise: Promise,
    // Captured before the worker starts: teardown must not make a running
    // write re-query module/app state and continue with an unrelated export.
    val context: Context,
    val operationId: String,
    val kind: ExportKind = ExportKind.FILE,
    val filename: String? = null,
    val mimeType: String? = null,
    val lifecycle: ExportLifecycle = ExportLifecycle(),
  )

  private enum class ExportKind { FILE, MEDIA }

  private val lock = Any()
  private var pending: PendingExport? = null
  private lateinit var createDocumentLauncher: AppContextActivityResultLauncher<CreateDocumentInput, CreateDocumentResult>

  override fun definition() = ModuleDefinition {
    Name("NautiloFileExport")

    OnCreate {
      applicationContext()?.let { context ->
        // A failure remains retryable and is reported before any new source
        // acquisition by prepareExportCacheAsync, not swallowed as success.
        try { recoverPreviousProcessFiles(context) } catch (_: Exception) { }
      }
    }

    AsyncFunction("prepareExportCacheAsync") { promise: Promise ->
      val context = applicationContext()
        ?: return@AsyncFunction promise.reject("ERR_EXPORT_ACTIVITY", "File saving is unavailable right now.", null)
      try {
        recoverPreviousProcessFiles(context)
        promise.resolve(null)
      } catch (_: Exception) {
        promise.reject("ERR_EXPORT_CACHE_CLEANUP", "Temporary app copies could not be removed.", null)
      }
    }

    AsyncFunction("saveFileAsync") { input: Map<String, Any?>, promise: Promise ->
      val context = applicationContext()
        ?: return@AsyncFunction promise.reject("ERR_EXPORT_ACTIVITY", "A file destination is unavailable right now.", null)
      val source = trustedCacheFile(context, input["fileUri"] as? String)
        ?: return@AsyncFunction promise.reject("ERR_EXPORT_SOURCE", "The requested file is unavailable.", null)
      val requestId = input["requestId"] as? String
      if (requestId.isNullOrBlank()) {
        return@AsyncFunction promise.reject("ERR_EXPORT_REQUEST", "The file export request is unavailable.", null)
      }
      val filename = safeFilename(input["filename"] as? String)
        ?: return@AsyncFunction promise.reject("ERR_EXPORT_FILENAME", "The requested filename is unavailable.", null)
      val mimeType = input["mimeType"] as? String
      if (mimeType == null || !MIME_TYPE.matches(mimeType)) {
        return@AsyncFunction promise.reject("ERR_EXPORT_TYPE", "The requested file type is unavailable.", null)
      }

      synchronized(lock) {
        if (pending != null) {
          promise.reject("ERR_EXPORT_BUSY", "Another file export is already in progress.", null)
          return@AsyncFunction
        }
        pending = PendingExport(source, promise, context, requestId)
      }

      val export = synchronized(lock) { pending }
        ?: return@AsyncFunction
      try {
        createDocumentLauncher.launch(CreateDocumentInput(export.operationId, filename, mimeType)) { result ->
          handleDestinationResult(result)
        }
      } catch (_: Exception) {
        finish(export, error = "ERR_EXPORT_DESTINATION" to "A file destination is unavailable right now.")
      }
    }

    AsyncFunction("saveMediaAsync") { input: Map<String, Any?>, promise: Promise ->
      val context = applicationContext()
        ?: return@AsyncFunction promise.reject("ERR_EXPORT_ACTIVITY", "Media saving is unavailable right now.", null)
      val source = trustedCacheFile(context, input["fileUri"] as? String)
        ?: return@AsyncFunction promise.reject("ERR_MEDIA_SOURCE", "The requested photo or video is unavailable.", null)
      val requestId = input["requestId"] as? String
      if (requestId.isNullOrBlank()) {
        return@AsyncFunction promise.reject("ERR_EXPORT_REQUEST", "The media export request is unavailable.", null)
      }
      val filename = safeFilename(input["filename"] as? String)
        ?: return@AsyncFunction promise.reject("ERR_EXPORT_FILENAME", "The requested filename is unavailable.", null)
      val mimeType = input["mimeType"] as? String
      if (mimeType == null || !MIME_TYPE.matches(mimeType) ||
          (!mimeType.startsWith("image/", ignoreCase = true) && !mimeType.startsWith("video/", ignoreCase = true))) {
        return@AsyncFunction promise.reject("ERR_MEDIA_TYPE", "Only photos and videos can be saved to the media library.", null)
      }

      val export = PendingExport(source, promise, context, requestId, ExportKind.MEDIA, filename, mimeType)
      synchronized(lock) {
        if (pending != null) {
          promise.reject("ERR_EXPORT_BUSY", "Another file export is already in progress.", null)
          return@AsyncFunction
        }
        pending = export
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ||
          ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) {
        startMediaWrite(export)
      } else {
        val permissions = appContext.permissions
        if (permissions == null) {
          finish(export, error = "ERR_MEDIA_PERMISSION" to "Storage permission is unavailable on this Android version.")
          return@AsyncFunction
        }
        permissions.askForPermissions(PermissionsResponseListener { result ->
          val granted = result[Manifest.permission.WRITE_EXTERNAL_STORAGE]?.status == PermissionsStatus.GRANTED
          if (granted) startMediaWrite(export)
          else finish(export, error = "ERR_MEDIA_PERMISSION" to "Storage permission is required to save this item.")
        }, Manifest.permission.WRITE_EXTERNAL_STORAGE)
      }
    }

    // This acknowledges a cancellation request but does not claim withdrawal:
    // the pending promise settles only after the picker/copy reaches a real
    // terminal state. A completed user-owned copy is never retracted.
    AsyncFunction("cancelPendingExportAsync") { requestId: String ->
      synchronized(lock) {
        val current = pending ?: return@AsyncFunction false
        if (current.operationId != requestId) return@AsyncFunction false
        current.lifecycle.requestCancellation()
        true
      }
    }

    RegisterActivityContracts {
      createDocumentLauncher = registerForActivityResult(CreateDocumentContract())
    }

    OnDestroy {
      interruptPendingExport()?.promise?.reject("ERR_EXPORT_INTERRUPTED", "The file export was interrupted.", null)
    }
  }

  private fun applicationContext() = appContext.reactContext?.applicationContext

  private fun selectDestination(export: PendingExport): DestinationTransition = synchronized(lock) {
    if (pending !== export) DestinationTransition.STALE else export.lifecycle.selectDestination()
  }

  private fun interruptPendingExport(): PendingExport? = synchronized(lock) {
    val current = pending ?: return@synchronized null
    when (current.lifecycle.interrupt()) {
      InterruptTransition.REJECT_NOW -> {
        pending = null
        current
      }
      // A worker may own both the cache source and a newly-created destination.
      // Keep the promise/source lease until it reports saved, cancelled, or a
      // cleanup residual; rejecting here would let JS delete the source early.
      InterruptTransition.AWAIT_WRITER -> null
    }
  }

  private fun cancellationWasRequested(export: PendingExport): Boolean = synchronized(lock) {
    pending !== export || export.lifecycle.cancellationRequested
  }

  private fun finish(export: PendingExport, result: Map<String, String>? = null, error: Pair<String, String>? = null) {
    val active = synchronized(lock) {
      if (pending !== export) false else {
        pending = null
        true
      }
    }
    if (!active) return
    if (result != null) export.promise.resolve(result)
    else if (error != null) export.promise.reject(error.first, error.second, null)
  }

  private fun handleDestinationResult(result: CreateDocumentResult) {
    val export = synchronized(lock) {
      pending?.takeIf { it.operationId == result.operationId && it.kind == ExportKind.FILE }
    } ?: return
    val uri = result.destination
    if (uri == null) {
      finish(export, result = mapOf("status" to "cancelled"))
      return
    }
    when (selectDestination(export)) {
      DestinationTransition.WRITE -> Thread { writeSelectedDestination(export.context, export, uri) }.start()
      DestinationTransition.CANCELLED -> finishCancelledDestination(export, uri)
      DestinationTransition.STALE -> return
    }
  }

  private fun startMediaWrite(export: PendingExport) {
    when (selectDestination(export)) {
      DestinationTransition.WRITE -> Thread { writeMedia(export) }.start()
      DestinationTransition.CANCELLED -> finish(export, result = mapOf("status" to "cancelled"))
      DestinationTransition.STALE -> return
    }
  }

  private fun writeMedia(export: PendingExport) {
    val mimeType = export.mimeType ?: return finish(export, error = "ERR_MEDIA_TYPE" to "The requested media type is unavailable.")
    val filename = export.filename ?: return finish(export, error = "ERR_EXPORT_FILENAME" to "The requested filename is unavailable.")
    val resolver = export.context.contentResolver
    val isImage = mimeType.startsWith("image/", ignoreCase = true)
    if (!MediaSourceValidator.isValid(export.source, if (isImage) MediaFamily.IMAGE else MediaFamily.VIDEO)) {
      return finish(export, error = "ERR_MEDIA_INVALID" to "The file is not a valid photo or video.")
    }
    val collection = if (isImage) MediaStore.Images.Media.EXTERNAL_CONTENT_URI else MediaStore.Video.Media.EXTERNAL_CONTENT_URI
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, filename)
      put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val directory = if (isImage) Environment.DIRECTORY_PICTURES else Environment.DIRECTORY_MOVIES
        put(MediaStore.MediaColumns.RELATIVE_PATH, "$directory/Nautilo")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
    }
    var destination: android.net.Uri? = null
    try {
      if (cancellationWasRequested(export)) throw ExportCancelledException()
      destination = resolver.insert(collection, values) ?: throw IOException("MediaStore insert failed")
      resolver.openOutputStream(destination, "w")?.use { output ->
        FileInputStream(export.source).use { input ->
          val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
          while (true) {
            if (cancellationWasRequested(export)) throw ExportCancelledException()
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
          }
          output.flush()
        }
      } ?: throw IOException("MediaStore output stream unavailable")
      if (cancellationWasRequested(export)) throw ExportCancelledException()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val published = resolver.update(destination, ContentValues().apply {
          put(MediaStore.MediaColumns.IS_PENDING, 0)
        }, null, null)
        if (published != 1) throw IOException("MediaStore publish failed")
      }
      finish(export, result = mapOf("status" to "saved"))
    } catch (_: ExportCancelledException) {
      finishMediaFailure(export, destination, cancelled = true)
    } catch (_: Exception) {
      finishMediaFailure(export, destination, cancelled = false)
    }
  }

  private fun finishMediaFailure(export: PendingExport, destination: android.net.Uri?, cancelled: Boolean) {
    val deleted = destination == null || try {
      export.context.contentResolver.delete(destination, null, null) == 1
    } catch (_: Exception) {
      false
    }
    if (cancelled && deleted) {
      finish(export, result = mapOf("status" to "cancelled"))
      return
    }
    val action = if (cancelled) "cancelled" else "failed"
    val residual = if (deleted) "" else " A partial media-library item may remain."
    val code = when {
      cancelled && !deleted -> "ERR_MEDIA_CANCELLED_RESIDUAL"
      !cancelled && !deleted -> "ERR_MEDIA_SAVE_RESIDUAL"
      else -> "ERR_MEDIA_SAVE"
    }
    finish(export, error = code to "The media export $action.$residual")
  }

  private fun finishCancelledDestination(export: PendingExport, uri: android.net.Uri) {
    val active = takePending(export) ?: return
    val deleted = deleteNewDestination(active.context, uri)
    if (deleted) active.promise.resolve(mapOf("status" to "cancelled"))
    else active.promise.reject(
      "ERR_EXPORT_CANCELLED_RESIDUAL",
      "The file export was cancelled. An empty destination may remain in the selected location.",
      null,
    )
  }

  private fun takePending(export: PendingExport): PendingExport? = synchronized(lock) {
    if (pending !== export) return@synchronized null
    pending = null
    export
  }

  private fun trustedCacheFile(context: android.content.Context?, rawUri: String?): File? {
    if (context == null || rawUri.isNullOrBlank()) return null
    val uri = android.net.Uri.parse(rawUri)
    if (uri.scheme != "file") return null
    return try {
      val root = File(context.cacheDir, "nautilo-exports").canonicalFile
      val candidate = File(requireNotNull(uri.path)).canonicalFile
      val rootPath = root.path + File.separator
      if (!candidate.path.startsWith(rootPath) || !candidate.isFile) null else candidate
    } catch (_: Exception) {
      null
    }
  }

  private fun safeFilename(value: String?): String? {
    val name = value?.trim() ?: return null
    if (name.isEmpty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') || name.any { it.isISOControl() }) return null
    return name
  }

  private fun writeSelectedDestination(context: android.content.Context, export: PendingExport, uri: android.net.Uri) {
    try {
      FileInputStream(export.source).use { input ->
        val output = context.contentResolver.openOutputStream(uri, "w")
          ?: throw IOException("Destination stream unavailable")
        output.use {
          val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
          while (true) {
            if (cancellationWasRequested(export)) throw ExportCancelledException()
            val read = input.read(buffer)
            if (read < 0) break
            it.write(buffer, 0, read)
          }
          it.flush()
        }
      }
      finish(export, result = mapOf("status" to "saved"))
    } catch (_: ExportCancelledException) {
      val deleted = deleteNewDestination(export.context, uri)
      if (deleted) finish(export, result = mapOf("status" to "cancelled"))
      else finish(
        export,
        error = "ERR_EXPORT_CANCELLED_RESIDUAL" to "The file export was cancelled. A partial file may remain in the selected location.",
      )
    } catch (_: Exception) {
      val deleted = deleteNewDestination(export.context, uri)
      val message = if (deleted) {
        "The file could not be saved."
      } else {
        "The file could not be saved. A partial file may remain in the selected location."
      }
      val code = if (deleted) "ERR_EXPORT_WRITE" else "ERR_EXPORT_WRITE_RESIDUAL"
      finish(export, error = code to message)
    }
  }

  private fun deleteNewDestination(context: Context, uri: android.net.Uri): Boolean {
    // The only URI passed here came from this module's ACTION_CREATE_DOCUMENT
    // launcher. Android documents guidance specifies that Create Document does
    // not overwrite an existing file, so this can only target this export's
    // newly-created destination: https://developer.android.com/training/data-storage/shared/documents-files
    return try {
      DocumentsContract.deleteDocument(context.contentResolver, uri)
    } catch (_: Exception) {
      false
    }
  }

  private class ExportCancelledException : Exception()
}
