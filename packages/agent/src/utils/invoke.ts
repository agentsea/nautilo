import type { BaseMessageLike } from "@langchain/core/messages";
import type { ChatModel } from "../providers/types";
import { withTimeout } from "./time";
import { classifyError, formatErrorBrief, getRetryStrategy, waitForRetryDelay } from "./errors";
import { warn } from "@nautilo/logger";

export interface RetryOptions {
  attempts?: number;
  timeoutMs?: number;
  label?: string;
  signal?: AbortSignal;
}

export async function invokeWithRetry<M extends BaseMessageLike, R>(
  model: ChatModel<M, R>,
  messages: M[],
  opts?: RetryOptions
): Promise<R> {
  const attempts = Math.max(1, opts?.attempts ?? 3);
  const timeoutMs = Math.max(1000, opts?.timeoutMs ?? 30000);
  const label = opts?.label ?? "model.invoke";

  let lastErr: unknown = undefined;
  for (let i = 0; i < attempts; i++) {
    opts?.signal?.throwIfAborted();
    const controller = new AbortController();
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (!opts?.signal) return;
      onAbort = () => {
        const reason: unknown = opts.signal?.reason;
        controller.abort(reason);
        reject(reason instanceof Error ? reason : new Error("Model invocation cancelled", { cause: reason }));
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const p: Promise<R> = Promise.resolve(model.invoke(messages, { signal: controller.signal }));
      return await withTimeout<R>(Promise.race([p, cancelled]), timeoutMs, `${label} attempt ${i + 1}/${attempts}`);
    } catch (e) {
      // Stop the timed-out transport before admitting another attempt. Merely
      // racing its promise leaves the old provider request running in parallel.
      controller.abort(e);
      opts?.signal?.throwIfAborted();
      lastErr = e;
      const classified = classifyError(e);
      const strategy = getRetryStrategy(classified);
      const allowedAttempts = Math.min(attempts, strategy.maxAttempts);
      if (strategy.shouldRetry && i + 1 < allowedAttempts) {
        await Promise.race([waitForRetryDelay(i + 1, strategy), cancelled]);
        continue;
      }
      const brief = formatErrorBrief(e);
      warn(`[${label}] aborting after attempt ${i + 1}/${attempts} (${classified.category}): ${brief}`);
      break;
    } finally {
      if (onAbort) opts?.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr;
}
