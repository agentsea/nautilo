package ai.nautilo.fileexport

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaSourceValidatorTest {
  @Test fun acceptsOnlyStructurallyValidExpectedFamilies() {
    assertTrue(MediaSourceValidator.acceptsProbe(MediaFamily.IMAGE, "image/png", true))
    assertTrue(MediaSourceValidator.acceptsProbe(MediaFamily.VIDEO, "video/mp4", true))
    assertFalse(MediaSourceValidator.acceptsProbe(MediaFamily.IMAGE, "video/mp4", true))
    assertFalse(MediaSourceValidator.acceptsProbe(MediaFamily.VIDEO, "image/jpeg", true))
    assertFalse(MediaSourceValidator.acceptsProbe(MediaFamily.IMAGE, "image/png", false))
    assertFalse(MediaSourceValidator.acceptsProbe(MediaFamily.VIDEO, null, true))
  }
}
