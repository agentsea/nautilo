package ai.nautilo.fileexport

internal enum class ExportStage { PICKING, WRITING }
internal enum class DestinationTransition { WRITE, CANCELLED, STALE }
internal enum class InterruptTransition { REJECT_NOW, AWAIT_WRITER }

/** Pure state used under the module lock; intentionally independent of UI and I/O. */
internal class ExportLifecycle {
  var stage = ExportStage.PICKING
    private set
  var cancellationRequested = false
    private set

  fun requestCancellation() { cancellationRequested = true }

  fun interrupt(): InterruptTransition {
    requestCancellation()
    return if (stage == ExportStage.WRITING) InterruptTransition.AWAIT_WRITER else InterruptTransition.REJECT_NOW
  }

  fun selectDestination(): DestinationTransition = when {
    cancellationRequested -> DestinationTransition.CANCELLED
    stage != ExportStage.PICKING -> DestinationTransition.STALE
    else -> {
      stage = ExportStage.WRITING
      DestinationTransition.WRITE
    }
  }
}
