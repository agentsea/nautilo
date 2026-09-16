package ai.nautilo.fileexport

import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import java.io.File

internal enum class MediaFamily { IMAGE, VIDEO }

/** Validates decodability/container metadata without rewriting the source bytes. */
internal object MediaSourceValidator {
  fun isValid(source: File, expected: MediaFamily): Boolean = when (expected) {
    MediaFamily.IMAGE -> {
      val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(source.path, options)
      acceptsProbe(expected, options.outMimeType, options.outWidth > 0 && options.outHeight > 0)
    }
    MediaFamily.VIDEO -> {
      val retriever = MediaMetadataRetriever()
      try {
        retriever.setDataSource(source.path)
        acceptsProbe(
          expected,
          retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE),
          retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) == "yes",
        )
      } catch (_: Exception) {
        false
      } finally {
        try { retriever.release() } catch (_: Exception) { }
      }
    }
  }

  internal fun acceptsProbe(expected: MediaFamily, detectedMimeType: String?, structurallyValid: Boolean): Boolean {
    if (!structurallyValid) return false
    return when (expected) {
      MediaFamily.IMAGE -> detectedMimeType?.startsWith("image/", ignoreCase = true) == true
      MediaFamily.VIDEO -> detectedMimeType?.startsWith("video/", ignoreCase = true) == true
    }
  }
}
