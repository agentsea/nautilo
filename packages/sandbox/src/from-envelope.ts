/**
 * Helper: build a `Sandbox` from the server\u0027s per-turn envelope.
 * D060 Sprint 1 G5.4.c (ship plan v3 §5.4).
 *
 * Consumed by both the headless relay (`bin/nautilo-relay`) and the
 * Electron dispatch policy (`apps/desktop/electron/relay-dispatch/
 * local-dispatch-policy.ts`). Accepts a
 * STRUCTURAL input matching the `@nautilo/relay::RelaySandboxProfile`
 * shape but doesn\u0027t import from `@nautilo/relay` — keeps the
 * dependency direction clean (relay → sandbox, never the other way).
 *
 * The fields here MUST stay in sync with `RelaySandboxProfile` on
 * the protocol side. TypeScript\u0027s structural subtyping means a
 * RelaySandboxProfile instance satisfies this shape without a cast.
 */

import { Sandbox } from "./sandbox";
import type { SandboxConfig } from "./types";
import { DEFAULT_NETWORK_PORT } from "./network/policy";
import { isAbsolute } from "node:path";

/**
 * Structural mirror of the relay wire-format envelope. Kept local
 * to avoid a package dep; shape-compatible with
 * `@nautilo/relay::RelaySandboxProfile`.
 */
export interface SandboxEnvelopeLike {
  readonly workspace: string;
  readonly dataDir: string;
  readonly toolsBin: string;
  readonly config: SandboxConfig;
  /**
   * Must mirror `RelaySandboxProfile.failIfNoBackend`. The server's
   * deployment profile owns this — `serverRestrictive` +
   * `desktopLocked` set it true so paranoid posture fails loudly
   * when bwrap / sandbox-exec is missing; `desktopPermissive` sets
   * it false so a missing backend degrades to passthrough with a
   * WARN instead of refuse-to-execute.
   */
  readonly failIfNoBackend: boolean;
}

/**
 * PR-017 MINOR #2 — runtime shape validation at envelope entry.
 *
 * The envelope arrives over the relay WebSocket as parsed JSON.
 * `SandboxEnvelopeLike` is a compile-time contract — TypeScript
 * gives us no guarantee that the runtime shape matches. Without
 * validation, a protocol-drift bug (new server adds a required
 * field, old relay still deployed; or agent-controlled field
 * sneaks into the envelope path) silently passes a malformed
 * config to `Sandbox.create` which then either crashes later or,
 * worse, configures the sandbox with a truncated deny set.
 *
 * Mirrors the discipline applied in `@nautilo/config::posture-sidecar`
 * which parses an on-disk JSON blob with Zod before trusting it.
 * Hand-rolled here instead of adding a Zod dep to `@nautilo/sandbox`
 * — the shape is small enough that structural predicates beat a
 * dependency pull-in, and keeps sandbox architecturally lean
 * (per the package description: "OS-level sandbox containment —
 * no workspace-wide deps").
 *
 * On validation failure: throws `SandboxEnvelopeValidationError`
 * with the specific field + issue. Both relay call sites already
 * try/catch around `createSandboxFromEnvelope` and surface the
 * error as a dispatch `status: "error"` — same clean refusal path
 * as "envelope absent on release build" in the Desktop local dispatch
 * policy and headless relay. Paranoid
 * contract preserved by construction: a malformed envelope is
 * treated identically to an absent one on release.
 */
export class SandboxEnvelopeValidationError extends Error {
  override readonly name = "SandboxEnvelopeValidationError";
  constructor(public readonly issue: string) {
    super(`Sandbox envelope rejected: ${issue}`);
  }
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

function isStringArray(x: unknown): x is readonly string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

function isOptionalStringArray(x: unknown): x is readonly string[] | undefined {
  return x === undefined || isStringArray(x);
}

// eslint-disable-next-line no-control-regex -- rejects ambiguous path payloads
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

function isOptionalAbsolutePathArray(x: unknown): x is readonly string[] | undefined {
  return (
    x === undefined ||
    (Array.isArray(x) &&
      x.every(
        (value) =>
          typeof value === "string" &&
          value.length > 0 &&
          isAbsolute(value) &&
          !CONTROL_CHARACTER.test(value),
      ))
  );
}

function isOptionalAbsolutePath(x: unknown): x is string | undefined {
  return (
    x === undefined ||
    (typeof x === "string" && x.length > 0 && isAbsolute(x) && !CONTROL_CHARACTER.test(x))
  );
}

function isOptionalNumberArray(x: unknown): x is readonly number[] | undefined {
  return x === undefined ||
    (Array.isArray(x) && x.every((v) => Number.isInteger(v) && v > 0 && v <= 65_535));
}

/**
 * Validates the runtime shape of an envelope and returns it as
 * `SandboxEnvelopeLike`. Throws `SandboxEnvelopeValidationError`
 * on any mismatch. Exported for the relay tests + future shared
 * use (e.g. a dispatch-log sampler that wants to reject bad
 * envelopes before they reach the dispatch path).
 */
export function validateSandboxEnvelope(
  raw: unknown,
): SandboxEnvelopeLike {
  if (raw === null || typeof raw !== "object") {
    throw new SandboxEnvelopeValidationError(
      `expected object, got ${raw === null ? "null" : typeof raw}`,
    );
  }
  const e = raw as Record<string, unknown>;

  if (!isNonEmptyString(e["workspace"])) {
    throw new SandboxEnvelopeValidationError(
      "missing or empty `workspace` (required non-empty string)",
    );
  }
  if (!isNonEmptyString(e["dataDir"])) {
    throw new SandboxEnvelopeValidationError(
      "missing or empty `dataDir` (required non-empty string)",
    );
  }
  if (!isNonEmptyString(e["toolsBin"])) {
    throw new SandboxEnvelopeValidationError(
      "missing or empty `toolsBin` (required non-empty string)",
    );
  }
  if (typeof e["failIfNoBackend"] !== "boolean") {
    throw new SandboxEnvelopeValidationError(
      "missing `failIfNoBackend` (required boolean — paranoid-contract carrier)",
    );
  }

  const cfg = e["config"];
  if (cfg === null || typeof cfg !== "object") {
    throw new SandboxEnvelopeValidationError(
      `missing or non-object \`config\` (got ${cfg === null ? "null" : typeof cfg})`,
    );
  }
  const c = cfg as Record<string, unknown>;
  if (c["mode"] !== "enabled" && c["mode"] !== "disabled") {
    throw new SandboxEnvelopeValidationError(
      `config.mode must be "enabled" | "disabled", got ${JSON.stringify(c["mode"])}`,
    );
  }
  if (!isStringArray(c["writablePaths"])) {
    throw new SandboxEnvelopeValidationError(
      "config.writablePaths must be a string array",
    );
  }
  if (!isStringArray(c["projectPaths"])) {
    throw new SandboxEnvelopeValidationError(
      "config.projectPaths must be a string array",
    );
  }
  if (!isStringArray(c["passthroughEnv"])) {
    throw new SandboxEnvelopeValidationError(
      "config.passthroughEnv must be a string array",
    );
  }
  if (!isOptionalStringArray(c["readOnlyPaths"])) {
    throw new SandboxEnvelopeValidationError(
      "config.readOnlyPaths must be a string array or omitted",
    );
  }
  if (!isOptionalAbsolutePathArray(c["protectedPaths"])) {
    throw new SandboxEnvelopeValidationError(
      "config.protectedPaths must be an absolute, control-character-free string array or omitted",
    );
  }
  if (!isOptionalAbsolutePath(c["protectedFileMaskPath"])) {
    throw new SandboxEnvelopeValidationError(
      "config.protectedFileMaskPath must be an absolute, control-character-free string or omitted",
    );
  }
  validateOptionalNetworkPolicy(c["networkPolicy"]);

  return e as unknown as SandboxEnvelopeLike;
}

function validateOptionalNetworkPolicy(raw: unknown): void {
  if (raw === undefined) return;
  if (raw === null || typeof raw !== "object") {
    throw new SandboxEnvelopeValidationError("config.networkPolicy must be an object or omitted");
  }
  const policy = raw as Record<string, unknown>;
  const mode = policy["mode"];
  if (mode === "host" || mode === "isolated") {
    if (policy["allow"] !== undefined || policy["defaultPort"] !== undefined) {
      throw new SandboxEnvelopeValidationError(
        `config.networkPolicy.${mode} must not include allow/defaultPort fields`,
      );
    }
    return;
  }
  if (mode !== "proxy-allowlist") {
    throw new SandboxEnvelopeValidationError(
      `config.networkPolicy.mode must be host | isolated | proxy-allowlist, got ${JSON.stringify(mode)}`,
    );
  }
  const defaultPort = policy["defaultPort"];
  if (defaultPort !== undefined && defaultPort !== DEFAULT_NETWORK_PORT) {
    throw new SandboxEnvelopeValidationError("config.networkPolicy.defaultPort must be 443 when present");
  }
  const allow = policy["allow"];
  if (!Array.isArray(allow)) {
    throw new SandboxEnvelopeValidationError("config.networkPolicy.allow must be an array");
  }
  for (const [idx, rawRule] of allow.entries()) {
    validateNetworkRule(rawRule, idx);
  }
}

function validateNetworkRule(raw: unknown, idx: number): void {
  if (raw === null || typeof raw !== "object") {
    throw new SandboxEnvelopeValidationError(`config.networkPolicy.allow[${idx}] must be an object`);
  }
  const rule = raw as Record<string, unknown>;
  if (!isOptionalNumberArray(rule["ports"])) {
    throw new SandboxEnvelopeValidationError(`config.networkPolicy.allow[${idx}].ports must be valid port numbers`);
  }
  if (Array.isArray(rule["ports"]) && rule["ports"].length === 0) {
    throw new SandboxEnvelopeValidationError(`config.networkPolicy.allow[${idx}].ports must not be empty`);
  }
  if (rule["type"] === "domain") {
    if (!isNonEmptyString(rule["host"])) {
      throw new SandboxEnvelopeValidationError(`config.networkPolicy.allow[${idx}].host is required`);
    }
    return;
  }
  if (rule["type"] === "wildcard") {
    if (!isNonEmptyString(rule["suffix"])) {
      throw new SandboxEnvelopeValidationError(`config.networkPolicy.allow[${idx}].suffix is required`);
    }
    return;
  }
  if (rule["type"] === "cidr") {
    if (!isNonEmptyString(rule["cidr"])) {
      throw new SandboxEnvelopeValidationError(`config.networkPolicy.allow[${idx}].cidr is required`);
    }
    return;
  }
  throw new SandboxEnvelopeValidationError(
    `config.networkPolicy.allow[${idx}].type must be domain | wildcard | cidr`,
  );
}

/**
 * Construct a `Sandbox` from a per-turn envelope. Validates the
 * runtime shape first (PR-017 MINOR #2 defense-in-depth) then
 * delegates the backend detection + paranoid-fail logic to
 * `Sandbox.create()`. Throws `SandboxEnvelopeValidationError` on
 * invalid shape — both relay call sites surface this as a
 * dispatch error, matching the "envelope absent on release"
 * refusal semantics.
 */
export function createSandboxFromEnvelope(
  envelope: SandboxEnvelopeLike,
  localAuthority?: Readonly<{
    /** Runtime-only; never accepted from the serialized envelope. */
    allowWorkspaceGovernanceWrites?: boolean;
  }>,
): Promise<Sandbox> {
  // Validate even though the TS type says the shape is correct —
  // at the relay entry the value came from parsed JSON over WS
  // and has NOT been runtime-checked. Validation is idempotent +
  // cheap; running it always beats a "sometimes validated" path.
  const validated = validateSandboxEnvelope(envelope);

  return Sandbox.create({
    workspace: validated.workspace,
    dataDir: validated.dataDir,
    toolsBin: validated.toolsBin,
    config: validated.config,
    ...(localAuthority?.allowWorkspaceGovernanceWrites === true
      ? { allowWorkspaceGovernanceWrites: true }
      : {}),
    // Faithfully carry the server's paranoid-contract decision.
    // If the posture says "refuse without backend" the relay does
    // exactly that — previously (G5.4.c initial) this was hardcoded
    // to false, silently breaking the paranoid contract when
    // bwrap/sandbox-exec was missing. Self-review SEC-1 fix.
    failIfNoBackend: validated.failIfNoBackend,
  });
}
