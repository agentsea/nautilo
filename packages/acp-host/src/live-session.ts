import {
  AcpStableV1Adapter,
  type AcpStableV1AdapterOptions,
} from "./stable-v1-adapter.js";
import type {
  AcpLiveTurnRequest,
  AcpReadyBinding,
  AcpStableV1ReadinessConnector,
} from "./process-supervisor.js";

/**
 * A deliberately single-use stable-v1 connection.  The process runtime owns
 * its streams and lifetime; Electron supplies only typed projection callbacks
 * for one admitted prompt.
 */
export class AcpStableV1LiveSession implements AcpReadyBinding {
  #adapter: AcpStableV1Adapter | undefined;
  #used = false;
  #closed = false;

  constructor(readonly input: ReadableStream<Uint8Array>, readonly output: WritableStream<Uint8Array>, readonly cwd: string, readonly signal: AbortSignal) {}

  #result: Promise<import("./stable-v1-adapter.js").AcpTurnResult> | undefined;

  async start(request: AcpLiveTurnRequest): Promise<void> {
    if (this.#closed || this.#used || this.signal.aborted) throw new Error("ACP live session is unavailable");
    this.#used = true;
    let resolveStarted!: () => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    const onSessionStarted = async (input: Parameters<NonNullable<AcpStableV1AdapterOptions["onSessionStarted"]>>[0]) => {
      try {
        await request.onSessionStarted(input);
      } catch (error) {
        rejectStarted(error);
        throw error;
      }
    };
    const onPromptWritten = (input: Parameters<NonNullable<AcpStableV1AdapterOptions["onPromptWritten"]>>[0]) => {
      try {
        request.onPromptAdmitted?.(input);
        resolveStarted();
      } catch (error) {
        rejectStarted(error);
        throw error;
      }
    };
    const options: AcpStableV1AdapterOptions = {
      input: this.input,
      output: this.output,
      onNegotiated: request.onNegotiated,
      onSessionStarted,
      onPromptWritten,
      onEvent: request.onEvent,
      signal: this.signal,
      ...(request.sessionModeId ? { sessionModeId: request.sessionModeId } : {}),
      ...(request.onPermission ? { onPermission: request.onPermission } : {}),
      ...(request.onStopping ? { onStopping: request.onStopping } : {}),
    };
    const adapter = new AcpStableV1Adapter(options);
    this.#adapter = adapter;
    this.#result = adapter.runTurn({ cwd: this.cwd, prompt: request.prompt }).finally(() => { this.#adapter = undefined; });
    void this.#result.catch(rejectStarted);
    // The adapter owns the abort listener and rejects `started` with its fixed
    // closed fault, so no pre-session stream operation survives this await.
    await started;
  }

  turn(): Promise<import("./stable-v1-adapter.js").AcpTurnResult> {
    if (!this.#result) return Promise.reject(new Error("ACP turn is unavailable"));
    return this.#result;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#adapter?.stop().catch(() => undefined);
  }
}

export function createAcpStableV1LiveSessionConnector(
  turnFor: (request: Readonly<{ bindingId: string; registrationId: "hermes-acp" | "opencode-acp"; generation: number }>) => AcpLiveTurnRequest | undefined,
): AcpStableV1ReadinessConnector {
  return {
    async connect(request) {
      if (request.signal.aborted) throw new Error("ACP start was cancelled");
      const turn = turnFor(request);
      if (!turn) throw new Error("ACP start has no admitted turn");
      const session = new AcpStableV1LiveSession(request.input, request.output, request.cwd, request.signal);
      await session.start(turn);
      return session;
    },
  };
}
