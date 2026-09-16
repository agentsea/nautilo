/**
 * ISSUE-M206 — opaque local revision reference formatting and validation.
 *
 * Wire format: `local:<relayId>:<uuid>`
 */

import { randomUUID } from "node:crypto";

const REVISION_REF_PREFIX = "local:";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ParsedRevisionRef {
  relayId: string;
  revisionId: string;
}

export function formatRevisionRef(relayId: string, revisionId: string): string {
  return `${REVISION_REF_PREFIX}${relayId}:${revisionId}`;
}

export function parseRevisionRef(ref: string): ParsedRevisionRef | null {
  if (!ref.startsWith(REVISION_REF_PREFIX)) return null;
  const body = ref.slice(REVISION_REF_PREFIX.length);
  const lastColon = body.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const relayId = body.slice(0, lastColon);
  const revisionId = body.slice(lastColon + 1);
  if (!relayId || !UUID_RE.test(revisionId)) return null;
  return { relayId, revisionId };
}

export function validateRevisionRefForRelay(
  ref: string,
  expectedRelayId: string,
): { ok: true; revisionId: string } | { ok: false; code: "invalid_revision_ref" | "relay_ownership_mismatch" } {
  const parsed = parseRevisionRef(ref);
  if (!parsed) {
    return { ok: false, code: "invalid_revision_ref" };
  }
  if (parsed.relayId !== expectedRelayId) {
    return { ok: false, code: "relay_ownership_mismatch" };
  }
  return { ok: true, revisionId: parsed.revisionId };
}

export function newRevisionId(): string {
  return randomUUID();
}
