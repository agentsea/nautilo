import type {
  BoundThread,
  ChildIdentity,
  HostTimer,
  TurnTerminalWaiter,
} from "@nautilo/codex-app-server-host/internal";

const MAX_OBSERVED_TERMINALS = 256;

/**
 * Electron-main receipt tracker for one app-server `turn/completed` event.
 *
 * The shared supervisor owns interruption and process containment. This class
 * only proves that its exact child/binding/turn tuple reached a terminal
 * app-server notification, so it intentionally has no Task, Job, or process
 * control surface.
 */
export class ElectronCodexTurnTerminalTracker implements TurnTerminalWaiter {
  private readonly terminal = new Map<string, ReturnType<HostTimer["setTimeout"]>>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private closed = false;

  constructor(
    private readonly timer: HostTimer,
    private readonly terminalRetentionMs = 30_000,
  ) {}

  wait(input: Parameters<TurnTerminalWaiter["wait"]>[0]): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (!sameChild(input.child, input.binding.child)) return Promise.resolve(false);
    const key = terminalKey(input);
    if (this.terminal.has(key)) return Promise.resolve(true);
    if (input.timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timeout: this.timer.setTimeout(() => this.settleWaiter(key, waiter, false), input.timeoutMs),
      };
      let pending = this.waiters.get(key);
      if (!pending) {
        pending = new Set();
        this.waiters.set(key, pending);
      }
      pending.add(waiter);
      // A notification can arrive between the initial terminal lookup and
      // registration when a test/future adapter calls synchronously.
      if (this.terminal.has(key)) this.settleWaiter(key, waiter, true);
    });
  }

  /** Record only a terminal event whose full authority was resolved by host. */
  observe(input: {
    readonly child: ChildIdentity;
    readonly binding: BoundThread;
    readonly turnId: string;
  }): void {
    if (this.closed) return;
    if (!sameChild(input.child, input.binding.child)) return;
    const key = terminalKey(input);
    if (!this.terminal.has(key)) {
      // Event-before-wait is only a short hand-off race. Keep that receipt
      // bounded even if a noisy app-server emits terminals no one awaits.
      if (this.terminal.size >= MAX_OBSERVED_TERMINALS) {
        const oldest = this.terminal.entries().next().value;
        if (oldest) {
          this.timer.clearTimeout(oldest[1]);
          this.terminal.delete(oldest[0]);
        }
      }
      this.terminal.set(key, this.timer.setTimeout(() => {
        this.terminal.delete(key);
      }, this.terminalRetentionMs));
    }
    for (const waiter of [...(this.waiters.get(key) ?? [])]) {
      this.settleWaiter(key, waiter, true);
    }
  }

  /** Resolve pending waits false and clear every timer when the session closes. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [key, pending] of this.waiters) {
      for (const waiter of pending) {
        this.timer.clearTimeout(waiter.timeout);
        waiter.resolve(false);
      }
      this.waiters.delete(key);
    }
    for (const timeout of this.terminal.values()) this.timer.clearTimeout(timeout);
    this.terminal.clear();
  }

  private settleWaiter(key: string, waiter: Waiter, result: boolean): void {
    const pending = this.waiters.get(key);
    if (!pending?.delete(waiter)) return;
    this.timer.clearTimeout(waiter.timeout);
    if (pending.size === 0) this.waiters.delete(key);
    waiter.resolve(result);
  }
}

interface Waiter {
  readonly resolve: (result: boolean) => void;
  readonly timeout: ReturnType<HostTimer["setTimeout"]>;
}

function terminalKey(input: {
  readonly child: ChildIdentity;
  readonly binding: BoundThread;
  readonly turnId: string;
}): string {
  const { child, binding } = input;
  return JSON.stringify([
    child.profile.actorId,
    child.profile.profileHandle,
    child.profile.profileGeneration,
    child.accountGeneration,
    child.runtimeGeneration,
    child.childGeneration,
    binding.bindingId,
    binding.bindingGeneration,
    binding.threadId,
    input.turnId,
  ]);
}

function sameChild(left: ChildIdentity, right: ChildIdentity): boolean {
  return left.profile.actorId === right.profile.actorId
    && left.profile.profileHandle === right.profile.profileHandle
    && left.profile.profileGeneration === right.profile.profileGeneration
    && left.accountGeneration === right.accountGeneration
    && left.runtimeGeneration === right.runtimeGeneration
    && left.childGeneration === right.childGeneration;
}
