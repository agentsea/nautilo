package ai.nautilo.fileexport

import java.io.File
import java.io.IOException
import java.util.UUID

/**
 * Removes interrupted export staging directories from this module's exact,
 * app-private root. The caller establishes that root; this helper never
 * discovers or widens it. Kept API-24 compatible: no java.nio.file usage.
 */
internal object ExportCacheRecovery {
  @Throws(IOException::class)
  fun sweep(root: File) {
    val canonicalParent = root.parentFile?.canonicalFile
      ?: throw IOException("Export cache root has no parent")
    val canonicalRoot = root.canonicalFile
    if (canonicalRoot.path != File(canonicalParent, root.name).path) {
      throw IOException("Export cache root must not be a symbolic link")
    }
    if (!root.exists()) return
    if (!root.isDirectory) throw IOException("Export cache root is not a directory")

    val children = root.listFiles() ?: throw IOException("Could not list export cache root")
    for (child in children) {
      if (!isUuidName(child.name)) continue
      // A symlink is always an unlink-only leaf. Do not call isDirectory on it
      // (which follows it), including when it points back inside this root.
      if (isSymlink(child, canonicalRoot)) {
        delete(child)
        continue
      }
      // Defensive canonical-parent check: only direct root children are ever
      // recursive targets, even on an app-private filesystem.
      if (child.canonicalFile.parentFile?.path != canonicalRoot.path) {
        throw IOException("Export cache child escaped its root")
      }
      deleteTree(child)
    }
  }

  private fun isUuidName(name: String): Boolean = try {
    UUID.fromString(name).toString().equals(name, ignoreCase = true)
  } catch (_: IllegalArgumentException) {
    false
  }

  private fun isSymlink(file: File, canonicalParent: File): Boolean =
    file.canonicalFile.path != File(canonicalParent, file.name).path

  @Throws(IOException::class)
  private fun deleteTree(file: File) {
    val canonicalParent = file.parentFile?.canonicalFile
      ?: throw IOException("Export cache child has no parent")
    if (isSymlink(file, canonicalParent)) {
      delete(file)
      return
    }
    if (file.isDirectory) {
      val children = file.listFiles() ?: throw IOException("Could not list export cache child")
      for (child in children) deleteTree(child)
    }
    delete(file)
  }

  @Throws(IOException::class)
  private fun delete(file: File) {
    if (!file.delete()) throw IOException("Could not remove interrupted export cache entry")
  }
}
