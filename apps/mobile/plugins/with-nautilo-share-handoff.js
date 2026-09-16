const { withMainActivity } = require("expo/config-plugins");

const IMPORTS = [
  "import android.content.Context",
  "import android.content.Intent",
  "import android.net.Uri",
  "import android.provider.OpenableColumns",
  "import java.io.File",
  "import java.io.FileOutputStream",
  "import java.util.UUID",
];
const MAX_TEXT_OR_URL_BYTES = 1024;
const MAX_INBOUND_FILE_BYTES = 100 * 1024 * 1024;
const INBOUND_FILE_MAX_AGE_MILLIS = 10 * 60 * 1000;
const PREFERENCES_NAME = "ai.nautilo.share.handoff.v1";
const ID_KEY = "id";
const VALUE_KEY = "value";
const CREATED_AT_MILLIS_KEY = "created-at-millis";
const FILE_PREFERENCES_NAME = "ai.nautilo.share.handoff.file.v1";
const FILE_ID_KEY = "id";
const FILE_NATIVE_RECEIPT_ID_KEY = "native-receipt-id";
const FILE_NAME_KEY = "filename";
const FILE_MIME_KEY = "mime-type";
const FILE_SIZE_KEY = "size-bytes";
const FILE_CREATED_AT_MILLIS_KEY = "created-at-millis";
const FILE_INBOX_DIRECTORY = "nautilo-share-handoff";
const CAPTURE = `
  private fun cleanExpiredNautiloShareFiles() {
    val cutoff = System.currentTimeMillis() - ${INBOUND_FILE_MAX_AGE_MILLIS}
    val inbox = File(filesDir, "${FILE_INBOX_DIRECTORY}")
    inbox.listFiles()?.forEach { candidate ->
      if (candidate.isFile && candidate.lastModified() < cutoff) candidate.delete()
    }
    val preferences = getSharedPreferences("${FILE_PREFERENCES_NAME}", Context.MODE_PRIVATE)
    if (preferences.getLong("${FILE_CREATED_AT_MILLIS_KEY}", 0L) < cutoff) {
      preferences.edit().clear().commit()
    }
  }

  private fun nautiloSharedFilename(uri: Uri): String {
    val displayName = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
      val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
      if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
    }
    val cleaned = displayName.orEmpty().replace(Regex("[\\\\/\\\\p{Cntrl}]"), "_").trim().take(255)
    return if (cleaned.isEmpty()) "shared-file" else cleaned
  }

  private fun nautiloSharedExtension(filename: String): String {
    val dot = filename.lastIndexOf('.')
    return if (dot <= 0 || dot == filename.lastIndex) "" else filename.substring(dot).lowercase()
  }

  private fun nautiloSharedMime(intent: Intent, uri: Uri): String {
    val claimed = intent.type?.substringBefore(';')?.trim()?.lowercase().orEmpty()
    val resolved = contentResolver.getType(uri)?.substringBefore(';')?.trim()?.lowercase().orEmpty()
    return if (claimed.isNotEmpty()) claimed else resolved
  }

  /**
   * This is bounded candidate custody, not canonical upload or Room admission.
   * The server's classifyArtifactUpload and the Room attachment policy must
   * classify the opened bytes before any destination becomes eligible.
   */
  private fun isNautiloShareCandidate(filename: String, mimeType: String): Boolean {
    val extension = nautiloSharedExtension(filename)
    if (extension in setOf(".svg", ".zip", ".tar", ".7z", ".rar", ".gz", ".tgz", ".bz2", ".xz", ".app", ".exe", ".msi", ".dll", ".dylib", ".so", ".deb", ".rpm", ".pkg", ".apk")) return false
    if (mimeType == "image/svg+xml" || mimeType.contains("zip") || mimeType.contains("tar") || mimeType.contains("rar") || mimeType.contains("7z") || mimeType.contains("executable") || mimeType.contains("msdownload") || mimeType.contains("x-elf") || mimeType.contains("x-mach-binary")) return false
    if (mimeType == "application/octet-stream") return extension in setOf(".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".rs", ".go", ".py", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".sql", ".sh", ".bash", ".zsh", ".fish", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".mjs", ".cjs", ".pdf", ".docx", ".xlsx", ".pptx", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".opus", ".webm", ".ndjson", ".parquet", ".geojson", ".log", ".ini", ".mp4")
    if (mimeType.startsWith("image/") || mimeType.startsWith("audio/") || mimeType.startsWith("text/")) return true
    if (mimeType in setOf("video/mp4", "video/webm", "application/pdf", "application/json", "application/x-ndjson", "application/xml", "application/yaml", "application/toml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.presentationml.presentation")) return true
    return extension in setOf(".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".rs", ".go", ".py", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".sql", ".sh", ".bash", ".zsh", ".fish", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".mjs", ".cjs", ".pdf", ".docx", ".xlsx", ".pptx", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".opus", ".webm", ".ndjson", ".parquet", ".geojson", ".log", ".ini", ".mp4")
  }

  @Suppress("DEPRECATION")
  private fun captureNautiloSharedFile(intent: Intent): Boolean {
    val stream = intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri ?: return false
    if (intent.clipData != null && intent.clipData?.itemCount != 1) return false
    cleanExpiredNautiloShareFiles()
    val filename = nautiloSharedFilename(stream)
    val mimeType = nautiloSharedMime(intent, stream)
    if (!isNautiloShareCandidate(filename, mimeType)) return false

    val preferences = getSharedPreferences("${FILE_PREFERENCES_NAME}", Context.MODE_PRIVATE)
    // Never overwrite a receipt JS has not yet securely staged and acknowledged.
    if (preferences.contains("${FILE_ID_KEY}")) return false

    val nativeReceiptId = UUID.randomUUID().toString()
    val handoffId = UUID.randomUUID().toString()
    val inbox = File(filesDir, "${FILE_INBOX_DIRECTORY}")
    if (!inbox.exists() && !inbox.mkdirs()) return false
    val temporary = File(inbox, ".\${nativeReceiptId}.tmp")
    val destination = File(inbox, nativeReceiptId)
    var copied = 0L
    try {
      contentResolver.openInputStream(stream)?.use { input ->
        FileOutputStream(temporary).use { output ->
          val buffer = ByteArray(32 * 1024)
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            copied += read.toLong()
            if (copied > ${MAX_INBOUND_FILE_BYTES}) throw IllegalArgumentException("Shared file exceeds receipt cap")
            output.write(buffer, 0, read)
          }
          output.fd.sync()
        }
      } ?: return false
      if (copied <= 0L || !temporary.renameTo(destination)) return false
      if (!preferences.edit()
        .putString("${FILE_ID_KEY}", handoffId)
        .putString("${FILE_NATIVE_RECEIPT_ID_KEY}", nativeReceiptId)
        .putString("${FILE_NAME_KEY}", filename)
        .putString("${FILE_MIME_KEY}", mimeType)
        .putLong("${FILE_SIZE_KEY}", copied)
        .putLong("${FILE_CREATED_AT_MILLIS_KEY}", System.currentTimeMillis())
        .commit()) {
        destination.delete()
        return false
      }
      return true
    } catch (_: Exception) {
      return false
    } finally {
      temporary.delete()
    }
  }

  private fun captureNautiloShareIntent(intent: Intent?) {
    if (intent?.action != Intent.ACTION_SEND) return
    if (intent.hasExtra(Intent.EXTRA_STREAM)) {
      captureNautiloSharedFile(intent)
      return
    }
    if (intent.type != "text/plain") return
    val value = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim().orEmpty()
    if (value.isEmpty() || value.toByteArray(Charsets.UTF_8).size > ${MAX_TEXT_OR_URL_BYTES}) return

    val preferences = getSharedPreferences("${PREFERENCES_NAME}", Context.MODE_PRIVATE)
    // Android can redeliver the same ACTION_SEND while the task is resumed.
    // Preserve its id until JS has durably staged and acknowledged it.
    if (preferences.getString("${VALUE_KEY}", null) == value && preferences.contains("${ID_KEY}")) return

    preferences.edit()
      .putString("${ID_KEY}", UUID.randomUUID().toString())
      .putString("${VALUE_KEY}", value)
      .putLong("${CREATED_AT_MILLIS_KEY}", System.currentTimeMillis())
      .commit()
  }
`;
const OVERRIDE = `
  override fun onNewIntent(intent: Intent) {
    captureNautiloShareIntent(intent)
    super.onNewIntent(intent)
    setIntent(intent)
  }
`;
const ON_CREATE_CAPTURE = "    captureNautiloShareIntent(intent)\n";

function patchMainActivity(source) {
  for (const statement of IMPORTS) {
    if (!source.includes(statement)) {
      source = source.replace("import android.os.Build", `${statement}\nimport android.os.Build`);
    }
  }
  if (!source.includes("private fun captureNautiloShareIntent")) {
    source = source.replace("  override fun onCreate(savedInstanceState: Bundle?) {", `${CAPTURE}\n  override fun onCreate(savedInstanceState: Bundle?) {`);
  }
  if (!source.includes("override fun onNewIntent(intent: Intent)")) {
    source = source.replace("  override fun onCreate(savedInstanceState: Bundle?) {", `${OVERRIDE}\n  override fun onCreate(savedInstanceState: Bundle?) {`);
  }
  if (!source.includes("override fun onNewIntent(intent: Intent) {\n    captureNautiloShareIntent(intent)")) {
    source = source.replace(
      "  override fun onNewIntent(intent: Intent) {\n",
      "  override fun onNewIntent(intent: Intent) {\n    captureNautiloShareIntent(intent)\n",
    );
  }
  if (!source.includes("override fun onCreate(savedInstanceState: Bundle?) {\n    captureNautiloShareIntent(intent)")) {
    source = source.replace("  override fun onCreate(savedInstanceState: Bundle?) {\n", `  override fun onCreate(savedInstanceState: Bundle?) {\n${ON_CREATE_CAPTURE}`);
  }
  return source;
}

module.exports = (config) => withMainActivity(config, (modConfig) => {
  modConfig.modResults.contents = patchMainActivity(modConfig.modResults.contents);
  return modConfig;
});

module.exports.constants = {
  IMPORTS,
  CAPTURE,
  OVERRIDE,
  MAX_TEXT_OR_URL_BYTES,
  MAX_INBOUND_FILE_BYTES,
  INBOUND_FILE_MAX_AGE_MILLIS,
  PREFERENCES_NAME,
  ID_KEY,
  VALUE_KEY,
  CREATED_AT_MILLIS_KEY,
  FILE_PREFERENCES_NAME,
  FILE_ID_KEY,
  FILE_NATIVE_RECEIPT_ID_KEY,
  FILE_NAME_KEY,
  FILE_MIME_KEY,
  FILE_SIZE_KEY,
  FILE_CREATED_AT_MILLIS_KEY,
  FILE_INBOX_DIRECTORY,
};
module.exports.patchMainActivity = patchMainActivity;
