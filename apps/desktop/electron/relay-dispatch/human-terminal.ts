import { parseHumanTerminalOperation, parseHumanTerminalOwner, type HumanTerminalOwner } from "../../../../packages/types/src/human-terminal";
import { bindHumanTerminalConsent, executeHumanTerminal, peekHumanTerminalConsent } from "../terminal-host";

/** Owner comes from authenticated foreground admission, never model args. The
 * callback must freshly revalidate server/Room/crypto and local session scope. */
export async function dispatchHumanTerminal(toolName: string, args: unknown, owner: HumanTerminalOwner,
  isCurrent: () => boolean | Promise<boolean>, signal?: AbortSignal, identity?: { generation: string; invocationId: string }) {
  const operation = parseHumanTerminalOperation(args);
  if (toolName !== "human_terminal" || !operation || !parseHumanTerminalOwner(owner) || !identity) {
    return { ok: false, action: operation?.action ?? "read", code: "invalid_request", inputWritten: false, retrySafe: true } as const;
  }
  const refusal = (code: "grant_required" | "authority_changed") => ({
    ok: false as const, action: operation.action, code,
    inputWritten: operation.action === "read" ? false as const : "unknown" as const,
    retrySafe: operation.action === "read",
  });
  const consent = peekHumanTerminalConsent();
  if (!consent || consent.generation !== identity.generation) return refusal("grant_required");
  let current = false;
  try { current = !signal?.aborted && await isCurrent(); } catch { /* fail closed */ }
  if (!current || signal?.aborted) return refusal("authority_changed");
  const grant = bindHumanTerminalConsent(owner, consent.generation);
  if (!grant) return refusal("grant_required");
  return executeHumanTerminal(owner, grant.generation, operation, isCurrent, signal, identity.invocationId);
}
