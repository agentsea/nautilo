/**
 * M037 — the command-approval engine: arity-first classifier + DB matcher.
 *
 * Two halves:
 *
 *  1. **Classifier** (pure, no DB) — `classifyCall` turns a tool call into
 *     one generalized `CommandSignature` + a stable canonical `signatureKey`.
 *     Generalization strategy is chosen per slot-kind (see `command-arity.ts`).
 *     The only place we tokenize is the free-form `shell_command` slot.
 *
 *  2. **Engine** (DB) — `matchCommandApproval` / `createCommandApproval` /
 *     `revokeCommandApproval` / `listCommandApprovals` persist + look up
 *     `room`/`always` standing approvals in `standing_approvals`.
 *
 * SAFETY BACKSTOP (invariant): a generalized approval can only ever
 * short-circuit the **`ask`** verb. The matcher is consulted on the `ask`
 * path only; `prove_it` / `block` are never bypassed. See ISSUE-M037.
 */

import { createHash } from "node:crypto";
import { posix as pathPosix } from "node:path";
import {
  and,
  asc,
  desc,
  eq,
  isNull,
  or,
  sql,
  getSharedDirectDb,
  standingApprovals,
  rooms,
} from "@nautilo/db";
import type { CommandSignature, CommandSignatureSlot } from "@nautilo/types";
import type { CapabilitySlug } from "./capabilities";
import { slotKindFor } from "./command-arity";

// ---------------------------------------------------------------------------
// Classifier output
// ---------------------------------------------------------------------------

export interface ClassifiedCall {
  toolName: string;
  /** Generalized signature — what `room`/`always` persist + match on. */
  signature: CommandSignature;
  /** Stable canonical string of `signature`; matcher compares on it. */
  signatureKey: string;
  /** Generalized rendering for the dialog, e.g. "run_shell ls <directory:/proj>". */
  generalizedDisplay: string;
  /** Literal rendering of the raw call, e.g. "run_shell ls /proj/a". */
  onceDisplay: string;
  /** True when nothing generalized (signature == exact args). */
  sameAsOnce: boolean;
}

// ---------------------------------------------------------------------------
// Shell head extraction — small known-subcommand table
// ---------------------------------------------------------------------------

/**
 * Known multi-token verb heads. The head of a shell command is the verb
 * plus any recognized subcommand chain (kept literal as `discriminator`
 * slots); everything after is an operand. Unknown verbs default to a
 * single-token head — anything we don't recognize is treated as an
 * operand, which produces a MORE specific signature (more re-prompts =
 * fail-safe). Each entry lists the space-joined subcommand paths that are
 * valid head extensions after the verb.
 */
const KNOWN_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set([
    "push", "pull", "fetch", "commit", "add", "status", "log", "diff",
    "checkout", "switch", "merge", "rebase", "branch", "tag", "stash",
    "clone", "reset", "init", "config", "show", "restore",
    "remote", "remote add", "remote remove", "remote set-url", "remote rename",
    "submodule", "submodule add", "submodule update", "submodule init",
  ]),
  npm: new Set([
    "install", "i", "run", "ci", "update", "uninstall", "publish", "test",
    "start", "build", "exec", "link", "audit",
  ]),
  bun: new Set([
    "install", "add", "remove", "run", "test", "build", "x", "create",
  ]),
  pnpm: new Set(["install", "add", "remove", "run", "test", "build", "exec"]),
  yarn: new Set(["install", "add", "remove", "run", "test", "build"]),
  docker: new Set([
    "run", "build", "ps", "exec", "compose", "compose up", "compose down",
    "compose build", "image", "image ls", "image rm", "logs", "pull", "push",
  ]),
  cargo: new Set(["build", "run", "test", "check", "add", "install", "fmt"]),
  kubectl: new Set([
    "get", "describe", "apply", "delete", "logs", "exec", "rollout",
    "rollout status", "rollout restart",
  ]),
};

function isFlag(token: string): boolean {
  return token.startsWith("-");
}

function isPathToken(token: string): boolean {
  return (
    token.includes("/") ||
    token.startsWith(".") ||
    token.startsWith("~")
  );
}

/**
 * Split a command line into tokens, honoring simple single/double quoting.
 * Quoted spans are kept as one token with the surrounding quotes stripped.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let sawChar = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      sawChar = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (sawChar) {
        tokens.push(current);
        current = "";
        sawChar = false;
      }
      continue;
    }
    current += ch;
    sawChar = true;
  }
  if (sawChar) tokens.push(current);
  return tokens;
}

/**
 * Length of the leading literal "head" (verb + recognized subcommands) of
 * a tokenized command. Stops at the first flag, path, or unrecognized
 * operand. Always at least 1 when there is a verb.
 */
function headLength(tokens: string[]): number {
  if (tokens.length === 0) return 0;
  if (isFlag(tokens[0]!) || isPathToken(tokens[0]!)) return 0;
  const verb = tokens[0]!;
  const known = KNOWN_SUBCOMMANDS[verb];
  let len = 1;
  if (known) {
    // Extend the head while verb + next tokens form a known subcommand path.
    while (len < tokens.length) {
      const next = tokens[len]!;
      if (isFlag(next) || isPathToken(next)) break;
      const candidate = tokens.slice(1, len + 1).join(" ");
      if (known.has(candidate)) {
        len += 1;
      } else {
        break;
      }
    }
  }
  return len;
}

// ---------------------------------------------------------------------------
// Path generalization
// ---------------------------------------------------------------------------

/** Generalize a path operand to its parent directory. */
function parentDirOf(rawPath: string): string {
  const trimmed = rawPath.replace(/\/+$/, "");
  const parent = pathPosix.dirname(trimmed);
  return parent;
}

// ---------------------------------------------------------------------------
// Slot building
// ---------------------------------------------------------------------------

/** Tokenize a shell command into ordered slots (head literals + operands). */
function shellCommandSlots(command: string): CommandSignatureSlot[] {
  const tokens = tokenizeCommand(command);
  const slots: CommandSignatureSlot[] = [];
  const head = headLength(tokens);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (i < head) {
      slots.push({ kind: "literal", token });
      continue;
    }
    if (isFlag(token)) {
      slots.push({ kind: "literal", token });
    } else if (isPathToken(token)) {
      slots.push({ kind: "directory", parent: parentDirOf(token) });
    } else {
      slots.push({ kind: "arg" });
    }
  }
  return slots;
}

/** Canonical, order-stable JSON for an opaque value. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * Classify a tool call into a generalized signature. Pure — uses
 * `TOOL_ARITY` + the shell tokenizer. No DB. Deterministic: the same
 * (toolName, args) always produces an identical `signatureKey`, which is
 * what makes server-restart re-classification on resume safe.
 */
export function classifyCall(
  toolName: string,
  args: Record<string, unknown>,
): ClassifiedCall {
  const argEntries = Object.keys(args ?? {})
    .sort()
    .map((k) => [k, (args ?? {})[k]] as const);

  const slots: CommandSignatureSlot[] = [];
  for (const [key, value] of argEntries) {
    const kind = slotKindFor(toolName, key);
    switch (kind) {
      case "shell_command": {
        const cmd = typeof value === "string" ? value : "";
        slots.push(...shellCommandSlots(cmd));
        break;
      }
      case "discriminator": {
        slots.push({ kind: "literal", token: String(value) });
        break;
      }
      case "path": {
        const p = typeof value === "string" ? value : String(value);
        slots.push({ kind: "directory", parent: parentDirOf(p) });
        break;
      }
      case "directory": {
        const d = typeof value === "string" ? value : String(value);
        slots.push({ kind: "directory", parent: d.replace(/\/+$/, "") });
        break;
      }
      case "amount":
      case "opaque":
      default: {
        // Interim: amount is treated as opaque (exact). No generalization.
        slots.push({ kind: "exact", arg: key, value: stableStringify(value) });
        break;
      }
    }
  }

  const signature: CommandSignature = { toolName, slots };
  const signatureKey = canonicalSignatureKey(signature);
  const generalizedDisplay = formatSignature(signature);
  const onceDisplay = formatOnceDisplay(toolName, args ?? {});
  const sameAsOnce = !slots.some(
    (s) => s.kind === "directory" || s.kind === "path" || s.kind === "arg",
  );
  return { toolName, signature, signatureKey, generalizedDisplay, onceDisplay, sameAsOnce };
}

/**
 * Stable canonical identity of a signature for indexed equality lookup.
 * Distinct from the human display (`formatSignature`). Uses control-char
 * delimiters that never appear in normal command content. NOTE: we avoid
 * NUL (`\u0000`) deliberately — Postgres `text` columns reject it
 * (`invalid byte sequence for encoding "UTF8": 0x00`). `\u001F` (unit
 * separator) and `\u001E` (record separator) are valid in PG text.
 *
 * PostgreSQL B-tree entries have a much smaller limit than `text`. Exact
 * opaque slots can contain whole patches or documents, so canonical values
 * over 1 KiB are represented by a fixed-length SHA-256 identity. Short keys
 * retain the legacy representation so existing standing approvals continue
 * to match without a migration.
 */
export function canonicalSignatureKey(sig: CommandSignature): string {
  const parts = sig.slots.map((s) => {
    switch (s.kind) {
      case "literal":
        return `L:${s.token}`;
      case "directory":
        return `D:${s.parent}`;
      case "path":
        return "P";
      case "arg":
        return "A";
      case "exact":
        return `E:${s.arg}=${s.value}`;
    }
  });
  const canonical = `${sig.toolName}\u001F${parts.join("\u001E")}`;
  if (Buffer.byteLength(canonical, "utf8") <= 1024) return canonical;
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/**
 * Single source of human display strings for a generalized signature,
 * e.g. "run_shell ls <directory:/proj>" or "file read <directory:/proj/a>".
 */
export function formatSignature(sig: CommandSignature): string {
  const rendered = sig.slots.map((s) => {
    switch (s.kind) {
      case "literal":
        return s.token;
      case "directory":
        return `<directory:${s.parent}>`;
      case "path":
        return "<path>";
      case "arg":
        return "<arg>";
      case "exact":
        return `${s.arg}=${s.value}`;
    }
  });
  return [sig.toolName, ...rendered].join(" ").trim();
}

/** Literal "once" rendering of the raw call, for the dialog's Once line. */
function formatOnceDisplay(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "run_shell" && typeof args["command"] === "string") {
    return `${toolName} ${args["command"]}`.trim();
  }
  const rendered = Object.keys(args)
    .sort()
    .map((k) => {
      const v = args[k];
      return `${k}: ${typeof v === "string" ? v : stableStringify(v)}`;
    })
    .join(", ");
  return rendered ? `${toolName}(${rendered})` : toolName;
}

// ---------------------------------------------------------------------------
// Engine — DB matcher + writer
// ---------------------------------------------------------------------------

export type CommandApprovalScope = "room" | "server";

export const APPROVAL_KIND_TOOL = "tool" as const;
export const APPROVAL_KIND_CAPABILITY = "capability" as const;
export type ApprovalKind =
  | typeof APPROVAL_KIND_TOOL
  | typeof APPROVAL_KIND_CAPABILITY;

/** Sentinel `tool_pattern` for capability-scoped standing approvals. */
const CAPABILITY_TOOL_PATTERN = "_capability";

function scopeFilterForRoom(roomId: string | null) {
  return roomId !== null
    ? or(
        and(eq(standingApprovals.scope, "room"), eq(standingApprovals.roomId, roomId)),
        eq(standingApprovals.scope, "server"),
      )
    : eq(standingApprovals.scope, "server");
}

/** NULL session_id rows apply to every session; non-null rows are session-specific. */
function sessionFilterFor(sessionId: string | undefined) {
  if (sessionId === undefined) return isNull(standingApprovals.sessionId);
  return or(isNull(standingApprovals.sessionId), eq(standingApprovals.sessionId, sessionId));
}

function notExpiredFilter() {
  return or(
    isNull(standingApprovals.expiresAt),
    sql`${standingApprovals.expiresAt} > now()`,
  );
}

export interface CommandApprovalRow {
  id: string;
  scope: CommandApprovalScope;
  roomId: string | null;
  roomLabel: string | null;
  toolPattern: string;
  label: string;
  approvalKind: ApprovalKind;
  capabilitySlug: string | null;
  active: boolean;
  createdAt: string;
}

/**
 * Look up a matching standing approval for a pending `ask`-verb tool call.
 * Classifies the call, then queries rows for `created_by = userId`, active,
 * not expired, where `tool_pattern = toolName AND signature_key =
 * signatureKey` AND ((scope='room' AND room_id=roomId) OR scope='server').
 * Room scope wins over server when both match. Returns the matched row's
 * `{ id, scope }` or null.
 *
 * Consulted ONLY on the `ask` path — never `prove_it` / `block`.
 */
export async function matchCommandApproval(input: {
  userId: string;
  roomId: string | null;
  toolName: string;
  args: Record<string, unknown>;
}): Promise<{ id: string; scope: CommandApprovalScope } | null> {
  const { userId, roomId, toolName, args } = input;
  if (!userId) return null;
  const { signatureKey } = classifyCall(toolName, args ?? {});

  const db = getSharedDirectDb();
  const rowsFound = await db
      .select({ id: standingApprovals.id, scope: standingApprovals.scope })
      .from(standingApprovals)
      .where(
        and(
          eq(standingApprovals.createdBy, userId),
          eq(standingApprovals.active, true),
          eq(standingApprovals.approvalKind, APPROVAL_KIND_TOOL),
          eq(standingApprovals.toolPattern, toolName),
          eq(standingApprovals.signatureKey, signatureKey),
          notExpiredFilter(),
          scopeFilterForRoom(roomId),
        ),
      )
      // Room scope wins over server when both match. Order by the boolean
      // (scope = 'room') DESC so the room-scoped row sorts first regardless
      // of the alphabetical ordering of the scope strings.
      .orderBy(sql`${standingApprovals.scope} = 'room' DESC`);

    const top = rowsFound[0];
    if (!top) return null;
  return { id: top.id, scope: top.scope as CommandApprovalScope };
}

/**
 * Idempotent (code-level): SELECT an active row on
 * `(created_by, scope, room_id, tool_pattern, signature_key)`; no-op on
 * hit, else INSERT. A naive UNIQUE index would NOT dedupe server-scope
 * rows because Postgres treats NULL room_id as distinct.
 */
export async function createCommandApproval(input: {
  userId: string;
  scope: CommandApprovalScope;
  roomId: string | null; // required iff scope === "room"
  toolName: string;
  signature: CommandSignature;
  signatureKey: string;
}): Promise<{ id: string; created: boolean }> {
  const { userId, scope, roomId, toolName, signature, signatureKey } = input;
  const effectiveRoomId = scope === "room" ? roomId : null;
  const db = getSharedDirectDb();
  const existing = await db
    .select({ id: standingApprovals.id })
    .from(standingApprovals)
    .where(
      and(
        eq(standingApprovals.createdBy, userId),
        eq(standingApprovals.active, true),
        eq(standingApprovals.approvalKind, APPROVAL_KIND_TOOL),
        eq(standingApprovals.scope, scope),
        notExpiredFilter(),
        effectiveRoomId === null
          ? isNull(standingApprovals.roomId)
          : eq(standingApprovals.roomId, effectiveRoomId),
        eq(standingApprovals.toolPattern, toolName),
        eq(standingApprovals.signatureKey, signatureKey),
      ),
    )
    .limit(1);
  const hit = existing[0];
  if (hit) return { id: hit.id, created: false };

  const [inserted] = await db
    .insert(standingApprovals)
    .values({
      createdBy: userId,
      approvalKind: APPROVAL_KIND_TOOL,
      toolPattern: toolName,
      scope,
      roomId: effectiveRoomId,
      signature,
      signatureKey,
      active: true,
    })
    .returning({ id: standingApprovals.id });
  if (!inserted) throw new Error("createCommandApproval: insert returned no row");
  return { id: inserted.id, created: true };
}

/**
 * Look up a matching capability-scoped standing approval for a pending
 * `ask`-verb tool call whose gate requires `capabilitySlug`. Matches any
 * invocation of tools gated by that capability until revoked — not an exact
 * arg signature. Room scope wins over server when both match.
 *
 * Consulted ONLY on the `ask` path — never `prove_it` / `block`.
 */
export async function matchCapabilityApproval(input: {
  userId: string;
  roomId: string | null;
  sessionId?: string;
  capabilitySlug: CapabilitySlug | (string & {});
}): Promise<{ id: string; scope: CommandApprovalScope } | null> {
  const { userId, roomId, sessionId, capabilitySlug } = input;
  if (!userId || !capabilitySlug) return null;

  const db = getSharedDirectDb();
  const sessionFilter = sessionFilterFor(sessionId);
  const rowsFound = await db
      .select({ id: standingApprovals.id, scope: standingApprovals.scope })
      .from(standingApprovals)
      .where(
        and(
          eq(standingApprovals.createdBy, userId),
          eq(standingApprovals.active, true),
          eq(standingApprovals.approvalKind, APPROVAL_KIND_CAPABILITY),
          eq(standingApprovals.capabilitySlug, capabilitySlug),
          notExpiredFilter(),
          scopeFilterForRoom(roomId),
          ...(sessionFilter ? [sessionFilter] : []),
        ),
      )
      .orderBy(sql`${standingApprovals.scope} = 'room' DESC`);

    const top = rowsFound[0];
    if (!top) return null;
  return { id: top.id, scope: top.scope as CommandApprovalScope };
}

/**
 * Idempotent (code-level): SELECT an active capability row on
 * `(created_by, scope, room_id, approval_kind, capability_slug, session_id)`;
 * no-op on hit, else INSERT.
 */
export async function createCapabilityApproval(input: {
  userId: string;
  scope: CommandApprovalScope;
  roomId: string | null;
  sessionId?: string | null;
  capabilitySlug: CapabilitySlug | (string & {});
  expiresAt?: Date | null;
}): Promise<{ id: string; created: boolean }> {
  const { userId, scope, roomId, sessionId, capabilitySlug, expiresAt } = input;
  const effectiveRoomId = scope === "room" ? roomId : null;
  const effectiveSessionId = sessionId ?? null;
  const db = getSharedDirectDb();
  const existing = await db
    .select({ id: standingApprovals.id })
    .from(standingApprovals)
    .where(
      and(
        eq(standingApprovals.createdBy, userId),
        eq(standingApprovals.active, true),
        eq(standingApprovals.approvalKind, APPROVAL_KIND_CAPABILITY),
        eq(standingApprovals.scope, scope),
        notExpiredFilter(),
        effectiveRoomId === null
          ? isNull(standingApprovals.roomId)
          : eq(standingApprovals.roomId, effectiveRoomId),
        eq(standingApprovals.capabilitySlug, capabilitySlug),
        effectiveSessionId === null
          ? isNull(standingApprovals.sessionId)
          : eq(standingApprovals.sessionId, effectiveSessionId),
      ),
    )
    .limit(1);
  const hit = existing[0];
  if (hit) return { id: hit.id, created: false };

  const [inserted] = await db
    .insert(standingApprovals)
    .values({
      createdBy: userId,
      approvalKind: APPROVAL_KIND_CAPABILITY,
      capabilitySlug,
      sessionId: effectiveSessionId,
      toolPattern: CAPABILITY_TOOL_PATTERN,
      scope,
      roomId: effectiveRoomId,
      active: true,
      expiresAt: expiresAt ?? null,
    })
    .returning({ id: standingApprovals.id });
  if (!inserted) throw new Error("createCapabilityApproval: insert returned no row");
  return { id: inserted.id, created: true };
}

/** Soft-revoke a standing approval (active=false). Scoped to the owner. */
export async function revokeCommandApproval(id: string, userId: string): Promise<void> {
  const db = getSharedDirectDb();
  await db
    .update(standingApprovals)
    .set({ active: false })
    .where(
      and(eq(standingApprovals.id, id), eq(standingApprovals.createdBy, userId)),
    );
}

/**
 * List this user's active command approvals for the Settings surface
 * (D235). Renders `label` server-side via `formatSignature`. Server-scope
 * rows have `roomId`/`roomLabel` null.
 */
export async function listCommandApprovals(userId: string): Promise<CommandApprovalRow[]> {
  const db = getSharedDirectDb();
  const found = await db
      .select({
        id: standingApprovals.id,
        scope: standingApprovals.scope,
        roomId: standingApprovals.roomId,
        roomLabel: rooms.label,
        toolPattern: standingApprovals.toolPattern,
        approvalKind: standingApprovals.approvalKind,
        capabilitySlug: standingApprovals.capabilitySlug,
        signature: standingApprovals.signature,
        active: standingApprovals.active,
        createdAt: standingApprovals.createdAt,
      })
      .from(standingApprovals)
      .leftJoin(rooms, eq(standingApprovals.roomId, rooms.id))
      .where(
        and(
          eq(standingApprovals.createdBy, userId),
          eq(standingApprovals.active, true),
        ),
      )
      .orderBy(asc(standingApprovals.scope), desc(standingApprovals.createdAt));

    return found
      .filter(
        (r) =>
          r.approvalKind === APPROVAL_KIND_CAPABILITY ||
          r.signature !== null,
      )
      .map((r) => {
        const approvalKind = (r.approvalKind ?? APPROVAL_KIND_TOOL) as ApprovalKind;
        const label =
          approvalKind === APPROVAL_KIND_CAPABILITY && r.capabilitySlug
            ? `capability: ${r.capabilitySlug}`
            : formatSignature(r.signature as CommandSignature);
        return {
          id: r.id,
          scope: r.scope as CommandApprovalScope,
          roomId: r.roomId,
          roomLabel: r.scope === "room" ? r.roomLabel : null,
          toolPattern: r.toolPattern,
          label,
          approvalKind,
          capabilitySlug: r.capabilitySlug,
          active: r.active,
          createdAt: r.createdAt.toISOString(),
        };
      });
}
