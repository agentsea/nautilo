package ai.nautilo.sharehandoff

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class NautiloShareHandoffModule : Module() {
  companion object {
    /**
     * The Activity captures ACTION_SEND into this private store before React
     * starts. That makes an OAuth callback, task recreation, or process
     * replacement unable to overwrite the user's share before JS has moved it
     * into encrypted SecureStore custody.
     */
    const val PREFERENCES_NAME = "ai.nautilo.share.handoff.v1"
    const val ID_KEY = "id"
    const val VALUE_KEY = "value"
    const val CREATED_AT_MILLIS_KEY = "created-at-millis"

    /** Must exactly match the pre-React Activity handoff plugin. */
    const val FILE_PREFERENCES_NAME = "ai.nautilo.share.handoff.file.v1"
    const val FILE_ID_KEY = "id"
    const val FILE_NATIVE_RECEIPT_ID_KEY = "native-receipt-id"
    const val FILE_NAME_KEY = "filename"
    const val FILE_MIME_KEY = "mime-type"
    const val FILE_SIZE_KEY = "size-bytes"
    const val FILE_CREATED_AT_MILLIS_KEY = "created-at-millis"
    const val FILE_INBOX_DIRECTORY = "nautilo-share-handoff"
    const val MAX_INBOUND_FILE_BYTES = 100L * 1024L * 1024L
    const val MAX_INBOUND_FILE_AGE_MILLIS = 10L * 60L * 1000L
  }

  override fun definition() = ModuleDefinition {
    Name("NautiloShareHandoff")

    AsyncFunction("peekAsync") {
      val preferences = pendingPreferences() ?: return@AsyncFunction null
      val id = preferences.getString(ID_KEY, null) ?: return@AsyncFunction null
      val value = preferences.getString(VALUE_KEY, null) ?: return@AsyncFunction null
      val createdAtMillis = preferences.getLong(CREATED_AT_MILLIS_KEY, 0L)
      if (value.isEmpty() || createdAtMillis <= 0L) return@AsyncFunction null
      val formatter = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
      }
      val kind = if (value.startsWith("https://") || value.startsWith("http://")) "url" else "text"
      mapOf(
        "version" to 1,
        "id" to id,
        "kind" to kind,
        "value" to value,
        "createdAt" to formatter.format(Date(createdAtMillis))
      )
    }

    AsyncFunction("ackAsync") { id: String ->
      val preferences = pendingPreferences() ?: return@AsyncFunction false
      if (preferences.getString(ID_KEY, null) != id) return@AsyncFunction false
      clearPreferences(preferences)
    }

    AsyncFunction("clearAsync") {
      pendingPreferences()?.let { clearPreferences(it) }
    }

    /**
     * Returns only durable metadata for one binary receipt. The raw file is
     * intentionally never represented by a URI/path/base64 value in this map.
     * `peekAsync` remains text-only so the established text consumer cannot
     * mistakenly clear an attachment receipt before its custody seam runs.
     */
    AsyncFunction("peekInboundFileAsync") {
      val context = applicationContext() ?: return@AsyncFunction null
      cleanExpiredInboundFiles(context)
      val preferences = inboundFilePreferences(context)
      val id = preferences.getString(FILE_ID_KEY, null) ?: return@AsyncFunction null
      val nativeReceiptId = preferences.getString(FILE_NATIVE_RECEIPT_ID_KEY, null) ?: return@AsyncFunction null
      val filename = preferences.getString(FILE_NAME_KEY, null) ?: return@AsyncFunction null
      val mimeType = preferences.getString(FILE_MIME_KEY, null) ?: return@AsyncFunction null
      val sizeBytes = preferences.getLong(FILE_SIZE_KEY, 0L)
      val createdAtMillis = preferences.getLong(FILE_CREATED_AT_MILLIS_KEY, 0L)
      val file = inboundFile(context, nativeReceiptId)
      if (!validInboundReceipt(id, nativeReceiptId, filename, mimeType, sizeBytes, createdAtMillis)
        || !file.isFile || file.length() != sizeBytes) {
        file.delete()
        clearInboundFilePreferences(preferences)
        return@AsyncFunction null
      }
      mapOf(
        "id" to id,
        "nativeReceiptId" to nativeReceiptId,
        "filename" to filename,
        "mimeType" to mimeType,
        "sizeBytes" to sizeBytes,
        "createdAt" to isoTimestamp(createdAtMillis),
      )
    }

    /**
     * Produces a transient, app-private content handle only after callers have
     * selected a receipt. It is deliberately not part of `peek` metadata and
     * is never persisted by this module.
     */
    AsyncFunction("openInboundFileAsync") { nativeReceiptId: String ->
      val context = applicationContext() ?: return@AsyncFunction null
      cleanExpiredInboundFiles(context)
      if (!validOpaqueId(nativeReceiptId)) return@AsyncFunction null
      val file = inboundFile(context, nativeReceiptId)
      if (!file.isFile || file.length() <= 0L || file.length() > MAX_INBOUND_FILE_BYTES) return@AsyncFunction null
      mapOf("contentUri" to FileProvider.getUriForFile(context, "${context.packageName}.nautilo.sharehandoff", file).toString())
    }

    /**
     * Ack happens only after encrypted JS metadata commits. It removes the
     * transient native handoff record but retains the protected bytes behind
     * their opaque native receipt until explicit discard/expiry.
     */
    AsyncFunction("ackInboundFileAsync") { id: String ->
      val context = applicationContext() ?: return@AsyncFunction false
      val preferences = inboundFilePreferences(context)
      if (preferences.getString(FILE_ID_KEY, null) != id) return@AsyncFunction false
      clearInboundFilePreferences(preferences)
    }

    /** Explicit terminal cleanup for a staged receipt after send/discard/expiry. */
    AsyncFunction("discardInboundFileAsync") { nativeReceiptId: String ->
      val context = applicationContext() ?: return@AsyncFunction false
      if (!validOpaqueId(nativeReceiptId)) return@AsyncFunction false
      val deleted = inboundFile(context, nativeReceiptId).delete()
      val preferences = inboundFilePreferences(context)
      if (preferences.getString(FILE_NATIVE_RECEIPT_ID_KEY, null) == nativeReceiptId) {
        clearInboundFilePreferences(preferences)
      }
      deleted
    }
  }

  private fun pendingPreferences(): SharedPreferences? = appContext.reactContext
    ?.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  private fun applicationContext(): Context? = appContext.reactContext?.applicationContext

  private fun inboundFilePreferences(context: Context): SharedPreferences =
    context.getSharedPreferences(FILE_PREFERENCES_NAME, Context.MODE_PRIVATE)

  private fun inboundInbox(context: Context): File = File(context.filesDir, FILE_INBOX_DIRECTORY)

  /** Opaque UUID-ish keys make this path construction non-traversable. */
  private fun inboundFile(context: Context, nativeReceiptId: String): File =
    File(inboundInbox(context), nativeReceiptId)

  private fun validOpaqueId(value: String): Boolean = value.matches(Regex("^[a-zA-Z0-9-]{8,80}$"))

  private fun validInboundReceipt(
    id: String,
    nativeReceiptId: String,
    filename: String,
    mimeType: String,
    sizeBytes: Long,
    createdAtMillis: Long,
  ): Boolean = validOpaqueId(id)
    && validOpaqueId(nativeReceiptId)
    && filename.isNotBlank() && filename.length <= 255
    && mimeType.matches(Regex("^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$"))
    && sizeBytes in 1..MAX_INBOUND_FILE_BYTES
    && createdAtMillis > 0L
    && createdAtMillis <= System.currentTimeMillis() + 60_000L
    && System.currentTimeMillis() - createdAtMillis <= MAX_INBOUND_FILE_AGE_MILLIS

  private fun isoTimestamp(millis: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
  }.format(Date(millis))

  /** Best-effort expiry removes orphaned files even after Activity replacement. */
  private fun cleanExpiredInboundFiles(context: Context) {
    val cutoff = System.currentTimeMillis() - MAX_INBOUND_FILE_AGE_MILLIS
    inboundInbox(context).listFiles()?.forEach { candidate ->
      if (candidate.isFile && candidate.lastModified() < cutoff) candidate.delete()
    }
    val preferences = inboundFilePreferences(context)
    if (preferences.getLong(FILE_CREATED_AT_MILLIS_KEY, 0L) < cutoff) {
      clearInboundFilePreferences(preferences)
    }
  }

  /** commit is deliberate: an acknowledgement must survive process death. */
  private fun clearPreferences(preferences: SharedPreferences): Boolean = preferences.edit()
    .remove(ID_KEY)
    .remove(VALUE_KEY)
    .remove(CREATED_AT_MILLIS_KEY)
    .commit()

  private fun clearInboundFilePreferences(preferences: SharedPreferences): Boolean = preferences.edit()
    .remove(FILE_ID_KEY)
    .remove(FILE_NATIVE_RECEIPT_ID_KEY)
    .remove(FILE_NAME_KEY)
    .remove(FILE_MIME_KEY)
    .remove(FILE_SIZE_KEY)
    .remove(FILE_CREATED_AT_MILLIS_KEY)
    .commit()

}
