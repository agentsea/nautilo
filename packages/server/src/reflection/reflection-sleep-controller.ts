import type { ReflectionSemanticSchedulerStatus } from "@nautilo/types";

export interface ControlledReflectionSleepWorker {
  start(): void;
  stop(): Promise<void>;
  getHealth?(): ReflectionSemanticSchedulerStatus;
}

export interface ReflectionSleepControllerDeps {
  resolveWorker(): Promise<ControlledReflectionSleepWorker>;
}

/**
 * Serializes live Reflection/Sleep policy changes around the one process-local
 * worker. OFF never constructs the Reflection runtime, and a toggle that lands
 * while runtime construction is pending is rechecked before work can start.
 */
export class ReflectionSleepController {
  private desiredEnabled = false;
  private worker: ControlledReflectionSleepWorker | null = null;
  private transition: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ReflectionSleepControllerDeps) {}

  setEnabled(enabled: boolean): Promise<void> {
    this.desiredEnabled = enabled;
    const previous = this.transition.catch(() => undefined);
    const next = previous.then(async () => {
      if (!this.desiredEnabled) {
        await this.worker?.stop();
        return;
      }

      this.worker ??= await this.deps.resolveWorker();
      if (this.desiredEnabled) {
        this.worker.start();
      } else {
        await this.worker.stop();
      }
    });
    this.transition = next;
    return next;
  }

  stop(): Promise<void> {
    return this.setEnabled(false);
  }

  /** Does not construct the dormant runtime merely to render Admin status. */
  getHealth(): ReflectionSemanticSchedulerStatus | null {
    return this.worker?.getHealth?.() ?? null;
  }
}
