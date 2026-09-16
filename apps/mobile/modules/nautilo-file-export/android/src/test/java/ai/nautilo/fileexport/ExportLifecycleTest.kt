package ai.nautilo.fileexport

import org.junit.Assert.assertEquals
import org.junit.Test

class ExportLifecycleTest {
  @Test fun cancellationBeforeDestinationSelectWinsAtomically() {
    val lifecycle = ExportLifecycle()
    lifecycle.requestCancellation()
    assertEquals(DestinationTransition.CANCELLED, lifecycle.selectDestination())
  }

  @Test fun destinationSelectionCanOnlyStartOneWriter() {
    val lifecycle = ExportLifecycle()
    assertEquals(DestinationTransition.WRITE, lifecycle.selectDestination())
    assertEquals(DestinationTransition.STALE, lifecycle.selectDestination())
  }

  @Test fun interruptionBeforeDestinationRejectsImmediately() {
    val lifecycle = ExportLifecycle()
    assertEquals(InterruptTransition.REJECT_NOW, lifecycle.interrupt())
    assertEquals(true, lifecycle.cancellationRequested)
  }

  @Test fun interruptionDuringWriteRetainsOwnershipUntilWorkerCompletion() {
    val lifecycle = ExportLifecycle()
    assertEquals(DestinationTransition.WRITE, lifecycle.selectDestination())
    assertEquals(InterruptTransition.AWAIT_WRITER, lifecycle.interrupt())
    assertEquals(true, lifecycle.cancellationRequested)
  }
}
