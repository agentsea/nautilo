/**
 * M166 Phase B — whether a graph invocation STARTS a new turn (rebuild context
 * allowed) or RESUMES a suspended one (must continue the parked checkpoint —
 * never rebuild). Today this is implicit in which entry point fired; M166 makes
 * it explicit so Phase C can branch on it safely. Branches on NOTHING in M166.
 */
export type TurnKind = "fresh" | "resume";

/**
 * The ingress-shape inputs that distinguish a fresh turn from a resume. Both
 * fields are optional and derived from the input an executor/runner already
 * receives; absence means "not a resume".
 */
export interface TurnKindSignal {
  /** A resume reply payload (approval / identity / await `Command({ resume })`). */
  resume?: unknown;
  /** Subagent unpause from a parked checkpoint (null graph input). */
  continueFromCheckpoint?: boolean;
}

/**
 * Total classifier: every input shape maps to exactly one `TurnKind`. A parked
 * checkpoint continuation OR a resume reply payload ⇒ `"resume"`; otherwise a
 * cold/fresh start ⇒ `"fresh"`.
 */
export function classifyTurnKind(signal: TurnKindSignal): TurnKind {
  if (signal.continueFromCheckpoint === true) return "resume";
  if (signal.resume !== undefined) return "resume";
  return "fresh";
}
