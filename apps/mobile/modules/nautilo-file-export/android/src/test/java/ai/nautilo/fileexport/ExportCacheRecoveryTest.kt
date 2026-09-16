package ai.nautilo.fileexport

import java.io.File
import java.nio.file.Files
import java.util.UUID
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExportCacheRecoveryTest {
  @Test fun removesOnlyUuidNamedDirectChildren() {
    val parent = Files.createTempDirectory("export-recovery").toFile()
    try {
      val root = File(parent, "nautilo-exports").apply { mkdir() }
      val interrupted = File(root, UUID.randomUUID().toString()).apply { mkdir() }
      File(interrupted, "nested").apply { mkdir() }
      File(interrupted, "nested/file").writeText("partial")
      val sentinel = File(root, "keep-me").apply { mkdir() }

      ExportCacheRecovery.sweep(root)

      assertFalse(interrupted.exists())
      assertTrue(sentinel.exists())
      assertTrue(root.exists())
    } finally { parent.deleteRecursively() }
  }

  @Test fun artifactRootRemovesOnlyOperationUuidDirectories() {
    val parent = Files.createTempDirectory("artifact-recovery").toFile()
    try {
      val root = File(parent, "nautilo-artifacts").apply { mkdir() }
      val interrupted = File(root, UUID.randomUUID().toString()).apply { mkdir() }
      File(interrupted, "original.bin").writeText("partial")
      val legacy = File(root, "legacy-preview.bin").apply { writeText("preserve") }

      ExportCacheRecovery.sweep(root)

      assertFalse(interrupted.exists())
      assertTrue(legacy.exists())
      assertTrue(root.exists())
    } finally { parent.deleteRecursively() }
  }

  @Test fun unlinksUuidSymlinkWithoutFollowingItsOutsideTarget() {
    val parent = Files.createTempDirectory("export-recovery").toFile()
    try {
      val root = File(parent, "nautilo-exports").apply { mkdir() }
      val outside = File(parent, "outside").apply { mkdir() }
      val outsideFile = File(outside, "preserve").apply { writeText("outside") }
      val link = File(root, UUID.randomUUID().toString())
      Files.createSymbolicLink(link.toPath(), outside.toPath())

      ExportCacheRecovery.sweep(root)

      assertFalse(link.exists() || Files.exists(link.toPath()))
      assertTrue(outside.exists())
      assertTrue(outsideFile.exists())
    } finally { parent.deleteRecursively() }
  }

  @Test fun rejectsASymlinkRoot() {
    val parent = Files.createTempDirectory("export-recovery").toFile()
    try {
      val target = File(parent, "target").apply { mkdir() }
      val rootLink = File(parent, "nautilo-exports")
      Files.createSymbolicLink(rootLink.toPath(), target.toPath())

      val failed = runCatching { ExportCacheRecovery.sweep(rootLink) }.isFailure

      assertTrue(failed)
      assertTrue(target.exists())
    } finally { parent.deleteRecursively() }
  }
}
