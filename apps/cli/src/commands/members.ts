import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ApiError,
  type AdminProvisionMemberResponse,
  type AdminUserMutationReceipt,
  type AdminUserRow,
  type OwnedSharedRoom,
  type InviteListResult,
  type InviteMutationReceipt,
  type InviteSummary,
} from "@nautilo/api-client";
import type { Argv, CommandModule } from "yargs";
import {
  AuthenticatedAdminClientError,
  createAuthenticatedAdminClient,
  type AuthenticatedAdminClient,
} from "../lib/authenticated-admin-client.ts";
import { readLine } from "../lib/prompts.ts";
import {
  ProtectedHandoffError,
  readProtectedHandoff,
  reserveProtectedHandoff,
  type ProtectedHandoffReservation,
} from "../lib/protected-handoff.ts";
import {
  writeServerAdminError,
  writeServerAdminSuccess,
  type ServerAdminFormat,
} from "../lib/server-admin-output.ts";
import { loginForAdminCommand } from "./login.ts";

const ROLE_CHOICES = ["admin", "superuser", "member", "contributor", "guest"] as const;
const MAX_PAGE_SIZE = 100;

type RoleChoice = (typeof ROLE_CHOICES)[number];
type BaseArgs = { server?: string; format: ServerAdminFormat };
type CreateArgs = BaseArgs & {
  role: RoleChoice;
  maxUses: number;
  expiresIn?: string;
  displayName?: string;
  handoffFile?: string;
};
type ListArgs = BaseArgs & { all: boolean; limit: number; cursor?: string };
type RevokeArgs = BaseArgs & { id: string; yes: boolean };
type MemberListArgs = BaseArgs & {
  limit: number;
  cursor?: string;
  search?: string;
  includeFederated: boolean;
};
type MemberTargetArgs = BaseArgs & { selector: string };
type MemberMutationArgs = MemberTargetArgs & { yes: boolean; reason?: string };
type ResetPasswordArgs = MemberTargetArgs & { yes: boolean; handoffFile?: string };
type ProvisionMemberArgs = BaseArgs & {
  handle: string;
  displayName: string;
  email?: string;
  role: RoleChoice;
  handoffFile?: string;
  idempotencyKey?: string;
};
type EnsurePermanentMemberArgs = BaseArgs & {
  handle: string;
  displayName: string;
  email?: string;
  role: RoleChoice;
  credentialFile: string;
  idempotencyKey?: string;
};
type RolloutPlanArgs = BaseArgs & { file: string };
type RolloutApplyArgs = BaseArgs & {
  file: string;
  fingerprint: string;
  handoffFile?: string;
  idempotencyKey?: string;
};
type RolloutStatusArgs = BaseArgs & { rolloutId: string };
type RolloutResumeArgs = RolloutStatusArgs & { handoffFile?: string };
type RemoveMemberArgs = MemberTargetArgs & {
  yes: boolean;
  transferRoom?: string[];
  archiveRoom?: string[];
};

export interface MembersCommandDependencies {
  authenticate(input: { serverFlag?: string }): Promise<AuthenticatedAdminClient>;
  login(input: { serverFlag?: string }): Promise<void>;
  reserveHandoff(path: string): Promise<ProtectedHandoffReservation>;
  prompt(text: string): Promise<string>;
  isInteractive(): boolean;
  now(): number;
  createIdempotencyKey(): string;
  readManifest(path: string): Promise<unknown>;
}

const DEFAULT_DEPENDENCIES: MembersCommandDependencies = {
  authenticate: (input) => createAuthenticatedAdminClient(input),
  login: loginForAdminCommand,
  reserveHandoff: reserveProtectedHandoff,
  prompt: readLine,
  isInteractive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  now: Date.now,
  createIdempotencyKey: randomUUID,
  readManifest: async (path) => {
    const bytes = await readFile(path);
    if (bytes.byteLength > 1024 * 1024) throw new Error("manifest_too_large");
    return JSON.parse(bytes.toString("utf8")) as unknown;
  },
};

async function authenticateInviteIntent(
  argv: BaseArgs,
  deps: MembersCommandDependencies,
): Promise<AuthenticatedAdminClient> {
  const input = authInput(argv.server);
  try {
    return await deps.authenticate(input);
  } catch (error) {
    if (
      !(error instanceof AuthenticatedAdminClientError)
      || error.code !== "login_required"
      || argv.format !== "human"
      || !deps.isInteractive()
    ) {
      throw error;
    }
  }

  await deps.login(input);
  return deps.authenticate(input);
}

function stableError(error: unknown): { code: string; message: string } {
  if (error instanceof AuthenticatedAdminClientError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof ProtectedHandoffError) {
    return { code: "handoff_unavailable", message: error.message };
  }
  if (error instanceof ApiError && error.status === 403) {
    return { code: "capability_denied", message: "The signed-in Human is not permitted to manage members." };
  }
  if (error instanceof ApiError && error.status === 404) {
    return { code: "not_found", message: "The requested resource was not found on the selected server." };
  }
  if (error instanceof ApiError && error.status === 409) {
    return { code: "member_conflict", message: "Current server policy blocks this member operation. Re-observe the member before continuing." };
  }
  if (error instanceof ApiError && error.status === 422) {
    return { code: "member_unsupported", message: "This member is managed by another authority or cannot use this operation." };
  }
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return { code: "invite_rejected", message: "The selected server rejected the invite request." };
  }
  return {
    code: "invite_unavailable",
    message: "The invite operation could not be completed safely. Observe current invite state before retrying.",
  };
}

function safeHuman(value: string | null, fallback = "-"): string {
  if (value === null || value.length === 0) return fallback;
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159) ? "�" : character;
    })
    .join("")
    .slice(0, 200);
}

function safeHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthenticatedAdminClientError("invalid_server_response");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new AuthenticatedAdminClientError("invalid_server_response");
  }
  return url.toString();
}

function memberState(row: AdminUserRow): string {
  return row.disabledAt ? "disabled" : "enabled";
}

function memberData(row: AdminUserRow): Record<string, unknown> {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.displayName,
    state: memberState(row),
    origin: row.server === null ? "local" : "federated",
    homeServer: row.server,
    groups: row.groups,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    disabledAt: row.disabledAt,
    disabledBy: row.disabledBy,
    disabledReason: row.disabledReason,
  };
}

function memberHuman(row: AdminUserRow): string[] {
  return [
    `id:          ${safeHuman(row.id)}`,
    `handle:      ${safeHuman(row.handle)}`,
    `displayName: ${safeHuman(row.displayName)}`,
    `state:       ${memberState(row)}`,
    `origin:      ${row.server === null ? "local" : `federated (${safeHuman(row.server)})`}`,
    `groups:      ${row.groups.map((group) => `${safeHuman(group.label)} (${safeHuman(group.roleSlug)})`).join(", ") || "(none)"}`,
  ];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function selectorKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

async function resolveMember(client: AuthenticatedAdminClient, selector: string): Promise<AdminUserRow> {
  if (UUID.test(selector)) return client.api.admin.users.get(selector);
  const target = selectorKey(selector);
  let cursor: string | undefined;
  const matches: AdminUserRow[] = [];
  for (;;) {
    const page = await client.api.admin.users.list({
      limit: MAX_PAGE_SIZE,
      includeFederated: true,
      ...(cursor ? { cursor } : {}),
    });
    matches.push(...page.users.filter((row) =>
      (row.handle !== null && selectorKey(row.handle) === target) ||
      selectorKey(row.displayName) === target));
    if (page.page.complete || !page.page.nextCursor) break;
    cursor = page.page.nextCursor;
  }
  if (matches.length === 0) throw new ApiError(404, "not found");
  if (matches.length > 1) {
    throw new ApiError(409, "ambiguous selector");
  }
  return matches[0]!;
}

async function handleMemberList(argv: MemberListArgs, deps: MembersCommandDependencies): Promise<void> {
  try {
    const client = await deps.authenticate(authInput(argv.server));
    requireMemberAuthority(client);
    const result = await client.api.admin.users.list({
      limit: argv.limit,
      includeFederated: argv.includeFederated,
      ...(argv.cursor ? { cursor: argv.cursor } : {}),
      ...(argv.search ? { search: argv.search } : {}),
    });
    writeServerAdminSuccess(
      argv.format,
      { members: result.users.map(memberData), page: result.page },
      result.users.length === 0
        ? ["No members in this page.", `complete: ${String(result.page.complete)}`]
        : [
            ...result.users.map((row) => `${safeHuman(row.id)}  ${safeHuman(row.handle)}  ${memberState(row)}  ${row.server === null ? "local" : "federated"}`),
            `returned: ${result.page.returned}`,
            `complete: ${String(result.page.complete)}`,
            ...(result.page.nextCursor ? [`nextCursor: ${safeHuman(result.page.nextCursor)}`] : []),
          ],
    );
    process.exitCode = 0;
  } catch (error) {
    const stable = stableError(error);
    writeServerAdminError(argv.format, stable.code, stable.message);
    process.exitCode = 2;
  }
}

async function handleMemberShow(argv: MemberTargetArgs, deps: MembersCommandDependencies): Promise<void> {
  try {
    const client = await deps.authenticate(authInput(argv.server));
    requireMemberAuthority(client);
    const member = await resolveMember(client, argv.selector);
    writeServerAdminSuccess(argv.format, memberData(member), memberHuman(member));
    process.exitCode = 0;
  } catch (error) {
    const stable = stableError(error);
    writeServerAdminError(argv.format, stable.code, stable.message);
    process.exitCode = 2;
  }
}

function memberReceipt(receipt: AdminUserMutationReceipt): Record<string, unknown> {
  return {
    stateChanged: receipt.stateChanged,
    auditRecorded: receipt.auditRecorded,
    retrySafe: receipt.retrySafe,
    receiptId: receipt.receiptId,
    recovery: receipt.recovery,
  };
}

async function handleMemberStateMutation(
  desired: "disabled" | "enabled",
  argv: MemberMutationArgs,
  deps: MembersCommandDependencies,
): Promise<void> {
  try {
    const client = await deps.authenticate(authInput(argv.server));
    requireMemberAuthority(client);
    const current = await resolveMember(client, argv.selector);
    if (!argv.yes) {
      if (!deps.isInteractive()) {
        writeServerAdminError(argv.format, "confirmation_required", `Non-interactive member ${desired === "disabled" ? "disable" : "enable"} requires --yes.`);
        process.exitCode = 2;
        return;
      }
      const answer = await deps.prompt(
        `${desired === "disabled" ? "Disable" : "Enable"} ${safeHuman(current.handle, current.id)} (current: ${memberState(current)})? [y/N]: `,
      );
      if (!new Set(["y", "yes"]).has(answer.trim().toLowerCase())) {
        writeServerAdminSuccess(argv.format, { memberId: current.id, stateChanged: false }, ["Member operation cancelled."]);
        process.exitCode = 0;
        return;
      }
    }

    try {
      const result = desired === "disabled"
        ? await client.api.admin.users.disable(current.id, argv.reason)
        : await client.api.admin.users.enable(current.id);
      writeServerAdminSuccess(
        argv.format,
        { memberId: current.id, previousState: memberState(current), currentState: desired, mutation: memberReceipt(result.mutation) },
        [
          `memberId:     ${safeHuman(current.id)}`,
          `previous:     ${memberState(current)}`,
          `current:      ${desired}`,
          `stateChanged: ${String(result.mutation.stateChanged)}`,
          `audit:        ${String(result.mutation.auditRecorded)}`,
        ],
      );
      process.exitCode = 0;
    } catch {
      const observed = await client.api.admin.users.get(current.id);
      if (memberState(observed) === desired) {
        writeServerAdminSuccess(
          argv.format,
          { memberId: current.id, currentState: desired, mutation: { stateChanged: "unknown", auditRecorded: "unknown", retrySafe: true, receiptId: current.id, recovery: [] } },
          [`Member is now observed as ${desired}; whether this command changed it is unknown.`],
        );
        process.exitCode = 0;
        return;
      }
      writeServerAdminError(
        argv.format,
        "member_outcome_unknown",
        `The member is not observed as ${desired}; this idempotent operation may be retried.`,
      );
      process.exitCode = 2;
    }
  } catch (error) {
    const stable = stableError(error);
    writeServerAdminError(argv.format, stable.code, stable.message);
    process.exitCode = 2;
  }
}

async function handleResetPassword(
  argv: ResetPasswordArgs,
  deps: MembersCommandDependencies,
): Promise<void> {
  let reservation: ProtectedHandoffReservation | undefined;
  let mutationAttempted = false;
  let committed = false;
  try {
    if (!argv.handoffFile) {
      writeServerAdminError(argv.format, "handoff_required", "Password reset requires --handoff-file with a new absolute path.");
      process.exitCode = 2;
      return;
    }
    reservation = await deps.reserveHandoff(argv.handoffFile);
    const client = await deps.authenticate(authInput(argv.server));
    requireMemberAuthority(client);
    const member = await resolveMember(client, argv.selector);
    if (!argv.yes) {
      if (!deps.isInteractive()) {
        writeServerAdminError(argv.format, "confirmation_required", "Non-interactive password reset requires --yes.");
        process.exitCode = 2;
        return;
      }
      const answer = await deps.prompt(`Issue a password-reset handoff for ${safeHuman(member.handle, member.id)}? [y/N]: `);
      if (!new Set(["y", "yes"]).has(answer.trim().toLowerCase())) {
        writeServerAdminSuccess(argv.format, { memberId: member.id, stateChanged: false }, ["Password reset cancelled."]);
        process.exitCode = 0;
        return;
      }
    }
    mutationAttempted = true;
    const result = await client.api.admin.users.resetPassword(member.id);
    committed = true;
    if (result.delivery === "one_time_url") {
      await reservation.write({
        schemaVersion: 1,
        kind: "nautilo.password-reset-handoff",
        delivery: result.delivery,
        memberId: member.id,
        url: safeHttpUrl(result.url),
        token: result.token,
      });
    } else {
      await reservation.write({
        schemaVersion: 1,
        kind: "nautilo.temporary-password-handoff",
        delivery: result.delivery,
        memberId: member.id,
        temporaryPassword: result.temporaryPassword,
        mustChangePassword: result.mustChangePassword,
      });
    }
    writeServerAdminSuccess(
      argv.format,
      {
        memberId: member.id,
        delivery: result.delivery,
        handoff: "protected_file",
        mutation: memberReceipt(result.mutation),
      },
      [
        "Password-reset handoff created.",
        `memberId: ${safeHuman(member.id)}`,
        "handoff:  written to the protected file",
        `audit:    ${String(result.mutation.auditRecorded)}`,
      ],
    );
    process.exitCode = 0;
  } catch (error) {
    const knownRejection = error instanceof ApiError && error.status >= 400 && error.status < 500;
    const ambiguous = committed || (mutationAttempted && !knownRejection);
    const stable = stableError(error);
    writeServerAdminError(
      argv.format,
      ambiguous ? "reset_outcome_unknown" : stable.code,
      ambiguous
        ? "A credential may have been rotated without a delivered handoff. A deliberate retry issues another reset and any prior handoff must be treated as potentially live until it is replaced or expires."
        : stable.message,
    );
    process.exitCode = 2;
  } finally {
    if (reservation) await reservation.discard();
  }
}

async function handleProvisionMember(
  argv: ProvisionMemberArgs,
  deps: MembersCommandDependencies,
): Promise<void> {
  let reservation: ProtectedHandoffReservation | undefined;
  const idempotencyKey = argv.idempotencyKey ?? deps.createIdempotencyKey();
  let mutationAttempted = false;
  try {
    if (!argv.handoffFile) {
      writeServerAdminError(
        argv.format,
        "handoff_required",
        "Direct provisioning requires --handoff-file with a new absolute path.",
      );
      process.exitCode = 2;
      return;
    }
    reservation = await deps.reserveHandoff(argv.handoffFile);
    const client = await deps.authenticate(authInput(argv.server));
    requireMemberAuthority(client);
    mutationAttempted = true;
    const result: AdminProvisionMemberResponse = await client.api.admin.users.provision(
      {
        handle: argv.handle,
        displayName: argv.displayName,
        ...(argv.email ? { email: argv.email } : {}),
        roleSlug: argv.role,
      },
      idempotencyKey,
    );
    if (result.credential.disposition === "issued") {
      await reservation.write({
        schemaVersion: 1,
        kind: "nautilo.provisioned-member-handoff",
        receiptId: result.receiptId,
        memberId: result.memberId,
        handle: argv.handle,
        temporaryPassword: result.credential.temporaryPassword,
        pin: result.credential.pin,
        recoveryCodes: result.credential.recoveryCodes,
        mustChangePassword: true,
      });
    }
    writeServerAdminSuccess(
      argv.format,
      {
        receiptId: result.receiptId,
        memberId: result.memberId,
        roleSlug: result.roleSlug,
        idempotent: result.idempotent,
        credentialDisposition: result.credential.disposition,
        handoff: result.credential.disposition === "issued" ? "protected_file" : "not_reissued",
        auditRecorded: result.auditRecorded,
      },
      [
        result.idempotent ? "Provisioning receipt already existed." : "Member provisioned.",
        `receiptId: ${safeHuman(result.receiptId)}`,
        `memberId:  ${safeHuman(result.memberId)}`,
        `role:      ${safeHuman(result.roleSlug)}`,
        result.credential.disposition === "issued"
          ? "handoff:   written to the protected file"
          : "handoff:   credentials were not reissued; use reset-password if the original handoff was lost",
      ],
    );
    process.exitCode = 0;
  } catch (error) {
    const stable = stableError(error);
    writeServerAdminError(
      argv.format,
      mutationAttempted ? "provision_outcome_unknown" : stable.code,
      mutationAttempted
        ? `Provisioning was not confirmed. Retry only with idempotency key ${idempotencyKey}; never choose a new key for the same intent.`
        : stable.message,
    );
    process.exitCode = 2;
  } finally {
    if (reservation) await reservation.discard();
  }
}

function parsePermanentCredential(
  value: unknown,
  expectedHandle: string,
): { password: string; pin: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtectedHandoffError();
  }
  const record = value as Record<string, unknown>;
  const handle = typeof record["handle"] === "string" ? record["handle"] : expectedHandle;
  const password = typeof record["password"] === "string"
    ? record["password"]
    : typeof record["permanentPassword"] === "string"
      ? record["permanentPassword"]
      : record["temporaryPassword"];
  if (
    handle !== expectedHandle
    || typeof password !== "string"
    || password.length === 0
    || typeof record["pin"] !== "string"
    || !/^\d{6}$/u.test(record["pin"])
  ) {
    throw new ProtectedHandoffError();
  }
  return { password, pin: record["pin"] };
}

async function handleEnsurePermanentMember(
  argv: EnsurePermanentMemberArgs,
  deps: MembersCommandDependencies,
): Promise<void> {
  try {
    const credential = parsePermanentCredential(
      await readProtectedHandoff(argv.credentialFile),
      argv.handle,
    );
    const client = await deps.authenticate(authInput(argv.server));
    requireMemberAuthority(client);
    const page = await client.api.admin.users.list({ search: argv.handle, limit: 100 });
    const matches = page.users.filter((member) =>
      member.server === null && member.handle === argv.handle);
    if (matches.length > 1) throw new Error("duplicate_local_handle");
    let memberId: string;
    let action: "restored" | "recreated";
    let auditRecorded: boolean;
    if (matches[0]) {
      const result = await client.api.admin.users.setPermanentCredentials(matches[0].id, credential);
      memberId = result.memberId;
      auditRecorded = result.auditRecorded;
      action = "restored";
    } else {
      const result = await client.api.admin.users.provision({
        handle: argv.handle,
        displayName: argv.displayName,
        ...(argv.email ? { email: argv.email } : {}),
        roleSlug: argv.role,
        permanentCredential: credential,
      }, argv.idempotencyKey ?? deps.createIdempotencyKey());
      memberId = result.memberId;
      auditRecorded = result.auditRecorded;
      action = "recreated";
    }
    writeServerAdminSuccess(argv.format, {
      memberId,
      handle: argv.handle,
      action,
      credentialSource: "protected_file",
      passwordChangeRequired: false,
      auditRecorded,
    }, [
      action === "recreated" ? "Permanent member recreated." : "Permanent member credentials restored.",
      `memberId: ${safeHuman(memberId)}`,
      `handle:   ${safeHuman(argv.handle)}`,
      "credential: retained in the protected source file",
      "password change required: false",
    ]);
    process.exitCode = 0;
  } catch (error) {
    const stable = stableError(error);
    writeServerAdminError(argv.format, stable.code, stable.message);
    process.exitCode = 2;
  }
}

async function handleRolloutPlan(
  argv: RolloutPlanArgs,
  deps: MembersCommandDependencies,
): Promise<void> {
  try {
    const manifest = await deps.readManifest(argv.file);
    const client = await deps.authenticate(authInput(argv.server));
    requireMemberAuthority(client);
    const plan = await client.api.admin.users.planRollout(manifest);
    writeServerAdminSuccess(
      argv.format,
      {
        schemaVersion: plan.schemaVersion,
        fingerprint: plan.fingerprint,
        serverInstanceId: plan.serverInstanceId,
        operations: plan.operations,
        warnings: plan.warnings,
        bounds: plan.bounds,
      },
      [
        `fingerprint: ${safeHuman(plan.fingerprint)}`,
        `server:      ${safeHuman(plan.serverInstanceId)}`,
        `members:     ${plan.operations.length}`,
        ...plan.operations.map((operation) =>
          `${operation.index + 1}. ${safeHuman(operation.handle)} -> ${safeHuman(operation.roleSlug)}`),
        "No changes were made.",
      ],
    );
    process.exitCode = 0;
  } catch (error) {
    const stable = stableError(error);
    writeServerAdminError(
      argv.format,
      error instanceof SyntaxError ? "invalid_manifest" : stable.code,
      error instanceof SyntaxError
        ? "The rollout manifest is not valid JSON."
        : stable.message,
    );
    process.exitCode = 2;
  }
}

async function writeRolloutHandoff(
  reservation: ProtectedHandoffReservation,
  rolloutId: string,
  credentials: Array<{
    sequence: number;
    handle: string;
    temporaryPassword: string;
    pin: string;
    recoveryCodes: string[];
  }>,
): Promise<void> {
  await reservation.write({
    schemaVersion: 1,
    kind: "nautilo.member-rollout-handoff",
    rolloutId,
    credentials,
  });
}

async function handleRolloutApply(
  argv: RolloutApplyArgs,
  deps: MembersCommandDependencies,
): Promise<void> {
  let reservation: ProtectedHandoffReservation | undefined;
  try {
    if (!argv.handoffFile) {
      writeServerAdminError(argv.format, "handoff_required", "Rollout apply requires --handoff-file with a new absolute path.");
      process.exitCode = 2;
      return;
    }
    const manifest = await deps.readManifest(argv.file);
    reservation = await deps.reserveHandoff(argv.handoffFile);
    const client = await deps.authenticate(authInput(argv.server));
    requireMemberAuthority(client);
    const idempotencyKey = argv.idempotencyKey ?? `rollout-${deps.createIdempotencyKey()}`;
    const result = await client.api.admin.users.applyRollout(manifest, argv.fingerprint, idempotencyKey);
    await writeRolloutHandoff(reservation, result.rolloutId, result.credentials);
    const sequences = result.credentials.map((credential) => credential.sequence);
    const status = sequences.length > 0
      ? await client.api.admin.users.acknowledgeRollout(result.rolloutId, sequences)
      : result;
    reservation = undefined;
    writeServerAdminSuccess(argv.format, {
      rolloutId: status.rolloutId,
      fingerprint: status.fingerprint,
      status: status.status,
      items: status.items,
      handoff: "protected_file",
      idempotencyKey,
    }, [
      `rolloutId: ${safeHuman(status.rolloutId)}`,
      `status:    ${safeHuman(status.status)}`,
      `members:   ${status.items.length}`,
      "handoff:   written to the protected file",
    ]);
    process.exitCode = 0;
  } catch (error) {
    const stable = stableError(error);
    writeServerAdminError(argv.format, stable.code, stable.message);
    process.exitCode = 2;
  } finally {
    if (reservation) await reservation.discard();
  }
}

async function handleRolloutStatus(
  argv: RolloutStatusArgs,
  deps: MembersCommandDependencies,
): Promise<void> {
  try {
    const client = await deps.authenticate(authInput(argv.server));
    requireMemberAuthority(client);
    const status = await client.api.admin.users.rolloutStatus(argv.rolloutId);
    writeServerAdminSuccess(argv.format, status, [
      `rolloutId: ${safeHuman(status.rolloutId)}`,
      `status:    ${safeHuman(status.status)}`,
      ...status.items.map((item) => `${item.sequence + 1}. ${safeHuman(item.handle)} -> ${safeHuman(item.state)}`),
    ]);
    process.exitCode = 0;
  } catch (error) {
    const stable = stableError(error);
    writeServerAdminError(argv.format, stable.code, stable.message);
    process.exitCode = 2;
  }
}

async function handleRolloutResume(
  argv: RolloutResumeArgs,
  deps: MembersCommandDependencies,
): Promise<void> {
  let reservation: ProtectedHandoffReservation | undefined;
  try {
    if (!argv.handoffFile) {
      writeServerAdminError(argv.format, "handoff_required", "Rollout resume requires --handoff-file with a new absolute path.");
      process.exitCode = 2;
      return;
    }
    reservation = await deps.reserveHandoff(argv.handoffFile);
    const client = await deps.authenticate(authInput(argv.server));
    requireMemberAuthority(client);
    const result = await client.api.admin.users.resumeRollout(argv.rolloutId);
    await writeRolloutHandoff(reservation, result.rolloutId, result.credentials);
    const sequences = result.credentials.map((credential) => credential.sequence);
    const status = sequences.length > 0
      ? await client.api.admin.users.acknowledgeRollout(result.rolloutId, sequences)
      : result;
    reservation = undefined;
    writeServerAdminSuccess(argv.format, {
      rolloutId: status.rolloutId,
      fingerprint: status.fingerprint,
      status: status.status,
      items: status.items,
      handoff: "protected_file",
    }, [
      `rolloutId: ${safeHuman(status.rolloutId)}`,
      `status:    ${safeHuman(status.status)}`,
      "handoff:   written to the protected file",
    ]);
    process.exitCode = 0;
  } catch (error) {
    const stable = stableError(error);
    writeServerAdminError(argv.format, stable.code, stable.message);
    process.exitCode = 2;
  } finally {
    if (reservation) await reservation.discard();
  }
}

type RoomRecovery =
  | { kind: "archive"; roomId: string }
  | { kind: "transfer"; roomId: string; newOwnerUserId: string };

function parseRoomRecovery(argv: RemoveMemberArgs): RoomRecovery[] {
  const actions: RoomRecovery[] = [];
  for (const roomId of argv.archiveRoom ?? []) {
    if (!UUID.test(roomId)) throw new ApiError(400, "invalid room id");
    actions.push({ kind: "archive", roomId });
  }
  for (const entry of argv.transferRoom ?? []) {
    const separator = entry.indexOf("=");
    const roomId = separator < 0 ? "" : entry.slice(0, separator);
    const newOwnerUserId = separator < 0 ? "" : entry.slice(separator + 1);
    if (!UUID.test(roomId) || !UUID.test(newOwnerUserId)) throw new ApiError(400, "invalid transfer");
    actions.push({ kind: "transfer", roomId, newOwnerUserId });
  }
  if (new Set(actions.map((action) => action.roomId)).size !== actions.length) {
    throw new ApiError(400, "duplicate room recovery");
  }
  return actions;
}

function removalPlan(member: AdminUserRow, blockers: OwnedSharedRoom[]): Record<string, unknown> {
  return {
    executable: blockers.length === 0,
    member: memberData(member),
    blockers: blockers.map((room) => ({
      code: "owns_shared_room",
      roomId: room.roomId,
      label: room.label,
      eligibleNewOwners: room.eligibleNewOwners,
      recovery: ["archive_room", "transfer_room"],
    })),
    consequence: "Permanently removes the local member and owned private product state, then attempts Logto revocation.",
  };
}

async function handleRemoveMember(
  argv: RemoveMemberArgs,
  deps: MembersCommandDependencies,
): Promise<void> {
  try {
    const client = await deps.authenticate(authInput(argv.server));
    requireMemberAuthority(client);
    const member = await resolveMember(client, argv.selector);
    if (client.whoami.sessionUserId === member.id) throw new ApiError(409, "self target");
    let blockers = (await client.api.admin.users.ownedSharedRooms(member.id)).rooms;
    const plan = removalPlan(member, blockers);
    if (!argv.yes) {
      writeServerAdminSuccess(
        argv.format,
        plan,
        [
          `Remove member ${safeHuman(member.handle, member.id)} (${safeHuman(member.id)}).`,
          "This permanently removes local product state and then attempts Logto revocation.",
          ...(blockers.length === 0
            ? ["No shared-room ownership blockers. Re-run with --yes to execute."]
            : [
                `Blocked by ${blockers.length} shared room(s):`,
                ...blockers.map((room) => `- ${safeHuman(room.label)} (${safeHuman(room.roomId)}): transfer to an eligible owner or archive`),
              ]),
        ],
      );
      process.exitCode = 0;
      return;
    }

    const actions = parseRoomRecovery(argv);
    const blockerIds = new Set(blockers.map((room) => room.roomId));
    if (actions.some((action) => !blockerIds.has(action.roomId)) || actions.length !== blockers.length) {
      writeServerAdminError(
        argv.format,
        "recovery_required",
        "Every currently blocking shared room requires exactly one --archive-room or --transfer-room room=new-owner action.",
      );
      process.exitCode = 2;
      return;
    }
    for (const action of actions) {
      try {
        if (action.kind === "archive") await client.api.admin.rooms.archive(action.roomId);
        else await client.api.admin.rooms.transferOwner(action.roomId, action.newOwnerUserId);
      } catch {
        // The response can be lost after the server commits. Re-observe the
        // canonical blocker set below instead of replaying a room mutation.
        break;
      }
    }
    blockers = (await client.api.admin.users.ownedSharedRooms(member.id)).rooms;
    if (blockers.length > 0) {
      writeServerAdminError(argv.format, "recovery_incomplete", "Shared-room recovery is incomplete. Re-run the removal plan before deleting the member.");
      process.exitCode = 2;
      return;
    }
    await client.api.admin.users.get(member.id);
    try {
      const result = await client.api.admin.users.delete(member.id);
      writeServerAdminSuccess(
        argv.format,
        { memberId: member.id, currentState: "removed", logtoRevoked: result.logtoRevoked, mutation: memberReceipt(result.mutation) },
        [
          `memberId:     ${safeHuman(member.id)}`,
          "current:      removed",
          `logtoRevoked: ${String(result.logtoRevoked)}`,
          `audit:        ${String(result.mutation.auditRecorded)}`,
        ],
      );
      process.exitCode = 0;
    } catch {
      try {
        await client.api.admin.users.get(member.id);
      } catch (observeError) {
        if (observeError instanceof ApiError && observeError.status === 404) {
          writeServerAdminSuccess(
            argv.format,
            { memberId: member.id, currentState: "removed", logtoRevoked: "unknown", mutation: { stateChanged: "unknown", auditRecorded: "unknown", retrySafe: false, receiptId: member.id, recovery: [{ kind: "reconcile_logto_user", userId: member.id }] } },
            ["The member is observed as removed; Logto revocation and audit state are unknown."],
          );
          process.exitCode = 0;
          return;
        }
        throw observeError;
      }
      writeServerAdminError(argv.format, "removal_outcome_unknown", "The member remains observable after an interrupted removal. Re-run the removal plan before deciding whether to retry.");
      process.exitCode = 2;
    }
  } catch (error) {
    const stable = stableError(error);
    writeServerAdminError(argv.format, stable.code, stable.message);
    process.exitCode = 2;
  }
}

function requireMemberAuthority(client: AuthenticatedAdminClient): void {
  if (!client.whoami.capabilities.includes("manage_members")) {
    throw new AuthenticatedAdminClientError("capability_denied");
  }
}

function authInput(server: string | undefined): { serverFlag?: string } {
  return server === undefined ? {} : { serverFlag: server };
}

function parseExpiry(value: string | undefined, now: number): string | null {
  if (value === undefined) return null;
  const match = /^(\d+)([smhd])$/u.exec(value.trim());
  if (!match) throw new ApiError(400, "invalid expiry");
  const amount = Number(match[1]);
  const unit = match[2];
  const factor = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > Math.floor(Number.MAX_SAFE_INTEGER / factor)) {
    throw new ApiError(400, "invalid expiry");
  }
  return new Date(now + amount * factor).toISOString();
}

function receiptData(receipt: InviteMutationReceipt): Record<string, unknown> {
  return {
    stateChanged: receipt.stateChanged,
    auditRecorded: receipt.auditRecorded,
    retrySafe: receipt.retrySafe,
    receiptId: receipt.receiptId,
    recovery: receipt.recovery,
  };
}

async function handleCreate(argv: CreateArgs, deps: MembersCommandDependencies): Promise<void> {
  const format = argv.format;
  let reservation: ProtectedHandoffReservation | undefined;
  let committed = false;
  let mutationAttempted = false;
  try {
    if ((format === "json" || !deps.isInteractive()) && !argv.handoffFile) {
      writeServerAdminError(
        format,
        "handoff_required",
        "Non-interactive and JSON invite creation requires --handoff-file with a new absolute path.",
      );
      process.exitCode = 2;
      return;
    }
    if (argv.handoffFile) reservation = await deps.reserveHandoff(argv.handoffFile);

    const client = await authenticateInviteIntent(argv, deps);
    requireMemberAuthority(client);
    mutationAttempted = true;
    const result = await client.api.createInvite({
      kind: "server",
      targetGroupRoleSlug: argv.role,
      maxUses: argv.maxUses,
      expiresAt: parseExpiry(argv.expiresIn, deps.now()),
      ...(argv.displayName ? { displayName: argv.displayName } : {}),
    });
    committed = true;
    const inviteUrl = safeHttpUrl(result.url);

    if (reservation) {
      await reservation.write({
        schemaVersion: 1,
        kind: "nautilo.invite-handoff",
        inviteId: result.id,
        url: inviteUrl,
        token: result.token,
        expiresAt: result.expiresAt,
        maxUses: result.maxUses,
      });
    }

    writeServerAdminSuccess(
      format,
      {
        inviteId: result.id,
        role: argv.role,
        expiresAt: result.expiresAt,
        maxUses: result.maxUses,
        handoff: reservation ? "protected_file" : "one_time_terminal",
        mutation: receiptData(result.mutation),
      },
      [
        "Invite created.",
        `inviteId:  ${result.id}`,
        `role:      ${argv.role}`,
        `expiresAt: ${result.expiresAt ?? "never"}`,
        `maxUses:   ${result.maxUses ?? "unlimited"}`,
        ...(reservation
          ? ["handoff:   written to the protected file"]
          : ["ONE-TIME INVITE URL (share securely):", inviteUrl]),
        `audit:     ${String(result.mutation.auditRecorded)}`,
      ],
    );
    process.exitCode = 0;
  } catch (error) {
    const stable = stableError(error);
    const knownRejection = error instanceof ApiError && error.status >= 400 && error.status < 500;
    const ambiguous = committed || (mutationAttempted && !knownRejection);
    writeServerAdminError(
      format,
      ambiguous ? "invite_outcome_unknown" : stable.code,
      ambiguous
        ? "Invite creation may have committed, but its handoff was not completed. List invites and revoke the new invite before retrying."
        : stable.message,
    );
    process.exitCode = 2;
  } finally {
    if (reservation) await reservation.discard();
  }
}

function inviteState(invite: InviteSummary): string {
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) return "expired";
  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) return "exhausted";
  return "active";
}

function listData(result: InviteListResult): Record<string, unknown> {
  return {
    invites: result.invites.map((invite) => ({ ...invite, state: inviteState(invite) })),
    page: result.page,
  };
}

async function handleList(argv: ListArgs, deps: MembersCommandDependencies): Promise<void> {
  try {
    const client = await deps.authenticate(authInput(argv.server));
    requireMemberAuthority(client);
    const result = await client.api.listInvites({
      all: argv.all,
      limit: argv.limit,
      ...(argv.cursor ? { cursor: argv.cursor } : {}),
    });
    writeServerAdminSuccess(
      argv.format,
      listData(result),
      result.invites.length === 0
        ? ["No invites in this page.", `complete: ${String(result.page.complete)}`]
        : [
            ...result.invites.map((invite) => `${invite.id}  ${invite.targetRoleSlug ?? "?"}  ${inviteState(invite)}  ${invite.usedCount}/${invite.maxUses ?? "∞"}`),
            `returned: ${result.page.returned}`,
            `complete: ${String(result.page.complete)}`,
            ...(result.page.nextCursor ? [`nextCursor: ${result.page.nextCursor}`] : []),
          ],
    );
    process.exitCode = 0;
  } catch (error) {
    const stable = stableError(error);
    writeServerAdminError(argv.format, stable.code, stable.message);
    process.exitCode = 2;
  }
}

async function findInvite(client: AuthenticatedAdminClient, id: string): Promise<InviteSummary | null> {
  let cursor: string | undefined;
  for (;;) {
    const page = await client.api.listInvites({ all: true, limit: MAX_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    const found = page.invites.find((invite) => invite.id === id);
    if (found) return found;
    if (page.page.complete || !page.page.nextCursor) return null;
    cursor = page.page.nextCursor;
  }
}

async function handleRevoke(argv: RevokeArgs, deps: MembersCommandDependencies): Promise<void> {
  try {
    const client = await deps.authenticate(authInput(argv.server));
    requireMemberAuthority(client);
    const current = await findInvite(client, argv.id);
    if (!current) throw new ApiError(404, "not found");

    if (!argv.yes) {
      if (!deps.isInteractive()) {
        writeServerAdminError(argv.format, "confirmation_required", "Non-interactive invite revocation requires --yes.");
        process.exitCode = 2;
        return;
      }
      const answer = await deps.prompt(`Revoke invite ${argv.id} (current: ${inviteState(current)})? [y/N]: `);
      if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
        writeServerAdminSuccess(argv.format, { inviteId: argv.id, stateChanged: false }, ["Invite revocation cancelled."]);
        process.exitCode = 0;
        return;
      }
    }

    try {
      const result = await client.api.revokeInvite(argv.id);
      writeServerAdminSuccess(
        argv.format,
        { inviteId: argv.id, currentState: inviteState(current), proposedState: "revoked", mutation: receiptData(result.mutation) },
        [
          `inviteId:     ${argv.id}`,
          `previous:     ${inviteState(current)}`,
          "current:      revoked",
          `stateChanged: ${String(result.mutation.stateChanged)}`,
          `audit:        ${String(result.mutation.auditRecorded)}`,
        ],
      );
      process.exitCode = 0;
    } catch {
      const observed = await findInvite(client, argv.id);
      if (observed?.revokedAt) {
        writeServerAdminSuccess(
          argv.format,
          { inviteId: argv.id, currentState: "revoked", mutation: { stateChanged: "unknown", auditRecorded: "unknown", retrySafe: true, receiptId: argv.id, recovery: [] } },
          ["The invite is now observed as revoked; whether this command changed it is unknown."],
        );
        process.exitCode = 0;
        return;
      }
      writeServerAdminError(
        argv.format,
        "invite_outcome_unknown",
        "Invite revocation was not confirmed. The invite is not observed as revoked; this idempotent revocation may be retried.",
      );
      process.exitCode = 2;
    }
  } catch (error) {
    const stable = stableError(error);
    writeServerAdminError(argv.format, stable.code, stable.message);
    process.exitCode = 2;
  }
}

function inviteBuilder(deps: MembersCommandDependencies): (yargs: Argv) => Argv {
  return (yargs) => yargs
    .command({
      command: "$0",
      describe: "Create a one-use member invite with a deliberate secret handoff.",
      builder: (child) => child
        .option("role", { type: "string", choices: ROLE_CHOICES, default: "member" })
        .option("max-uses", { type: "number", default: 1, demandOption: true })
        .option("expires-in", { type: "string", describe: "Optional duration such as 7d; omitted uses current no-expiry policy" })
        .option("display-name", { type: "string" })
        .option("handoff-file", { type: "string", describe: "New absolute owner-only JSON destination" })
        .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" })
        .check((args) => {
          if (!Number.isSafeInteger(args["max-uses"]) || Number(args["max-uses"]) < 1) throw new Error("invalid max uses");
          return true;
        }),
      handler: (args) => handleCreate(args as unknown as CreateArgs, deps),
    })
    .command({
      command: "list",
      describe: "List a bounded page of invites without bearer material.",
      builder: (child) => child
        .option("all", { type: "boolean", default: false, describe: "Include invites created by other authorized Humans" })
        .option("limit", { type: "number", default: 50 })
        .option("cursor", { type: "string" })
        .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" })
        .check((args) => {
          if (!Number.isSafeInteger(args["limit"]) || Number(args["limit"]) < 1 || Number(args["limit"]) > MAX_PAGE_SIZE) throw new Error("invalid limit");
          return true;
        }),
      handler: (args) => handleList(args as unknown as ListArgs, deps),
    })
    .command({
      command: "revoke <id>",
      describe: "Observe and revoke one invite by stable ID.",
      builder: (child) => child
        .positional("id", { type: "string", demandOption: true })
        .option("yes", { type: "boolean", default: false, describe: "Confirm revocation" })
        .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
      handler: (args) => handleRevoke(args as unknown as RevokeArgs, deps),
    })
    .demandCommand(0, 1)
    .strict();
}

export function createMembersModule(
  overrides: Partial<MembersCommandDependencies> = {},
): CommandModule {
  const deps = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return {
    command: "members",
    describe: "Administer Human membership through canonical server policy.",
    builder: (yargs) => yargs
      .command({
        command: "invite",
        describe: "Create, list, and revoke server invites.",
        builder: inviteBuilder(deps),
        handler: () => {},
      })
      .command({
        command: "rollout",
        describe: "Plan, apply, observe, and safely resume a bounded member rollout.",
        builder: (child) => child
          .command({
            command: "plan",
            describe: "Validate a secret-free manifest and return a server-bound fingerprint without writes.",
            builder: (plan) => plan
              .option("file", { type: "string", demandOption: true })
              .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
            handler: (args) => handleRolloutPlan(args as unknown as RolloutPlanArgs, deps),
          })
          .command({
            command: "apply",
            describe: "Apply an exact fresh rollout fingerprint with protected credential custody.",
            builder: (apply) => apply
              .option("file", { type: "string", demandOption: true })
              .option("fingerprint", { type: "string", demandOption: true })
              .option("handoff-file", { type: "string" })
              .option("idempotency-key", { type: "string" })
              .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
            handler: (args) => handleRolloutApply(args as unknown as RolloutApplyArgs, deps),
          })
          .command({
            command: "status <rollout-id>",
            describe: "Observe durable per-member rollout state without credentials.",
            builder: (status) => status
              .positional("rollout-id", { type: "string", demandOption: true })
              .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
            handler: (args) => handleRolloutStatus({
              ...(args as unknown as BaseArgs),
              rolloutId: String(args.rolloutId),
            }, deps),
          })
          .command({
            command: "resume <rollout-id>",
            describe: "Continue only server-proven safe unfinished rollout work.",
            builder: (resume) => resume
              .positional("rollout-id", { type: "string", demandOption: true })
              .option("handoff-file", { type: "string" })
              .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
            handler: (args) => handleRolloutResume({
              ...(args as unknown as BaseArgs & { handoffFile?: string }),
              rolloutId: String(args.rolloutId),
            }, deps),
          })
          .demandCommand(1, 1)
          .strict(),
        handler: () => {},
      })
      .command({
        command: "provision",
        describe: "Directly provision one local member with a protected first-use credential handoff.",
        builder: (child) => child
          .option("handle", { type: "string", demandOption: true })
          .option("display-name", { type: "string", demandOption: true })
          .option("email", { type: "string" })
          .option("role", { type: "string", choices: ROLE_CHOICES, default: "member" })
          .option("handoff-file", { type: "string", demandOption: true, describe: "New absolute owner-only JSON destination" })
          .option("idempotency-key", { type: "string", describe: "Stable retry key; generated when omitted" })
          .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
        handler: (args) => handleProvisionMember(args as unknown as ProvisionMemberArgs, deps),
      })
      .command({
        command: "ensure-permanent",
        describe: "Restore or recreate one local member from a permanent owner-only credential file.",
        builder: (child) => child
          .option("handle", { type: "string", demandOption: true })
          .option("display-name", { type: "string", demandOption: true })
          .option("email", { type: "string" })
          .option("role", { type: "string", choices: ROLE_CHOICES, default: "member" })
          .option("credential-file", { type: "string", demandOption: true, describe: "Existing absolute mode-0600 JSON credential source" })
          .option("idempotency-key", { type: "string", describe: "Stable retry key for a missing-account recreation" })
          .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
        handler: (args) => handleEnsurePermanentMember(
          args as unknown as EnsurePermanentMemberArgs,
          deps,
        ),
      })
      .command({
        command: "list",
        describe: "List a bounded page of the member directory.",
        builder: (child) => child
          .option("limit", { type: "number", default: 50 })
          .option("cursor", { type: "string" })
          .option("search", { type: "string", describe: "Literal handle or display-name search" })
          .option("include-federated", { type: "boolean", default: false })
          .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" })
          .check((args) => {
            if (!Number.isSafeInteger(args["limit"]) || Number(args["limit"]) < 1 || Number(args["limit"]) > MAX_PAGE_SIZE) throw new Error("invalid limit");
            return true;
          }),
        handler: (args) => handleMemberList(args as unknown as MemberListArgs, deps),
      })
      .command({
        command: "show <selector>",
        describe: "Show one unambiguously selected member.",
        builder: (child) => child
          .positional("selector", { type: "string", demandOption: true })
          .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
        handler: (args) => handleMemberShow(args as unknown as MemberTargetArgs, deps),
      })
      .command({
        command: "disable <selector>",
        describe: "Observe and suspend one local member.",
        builder: (child) => child
          .positional("selector", { type: "string", demandOption: true })
          .option("reason", { type: "string" })
          .option("yes", { type: "boolean", default: false })
          .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
        handler: (args) => handleMemberStateMutation("disabled", args as unknown as MemberMutationArgs, deps),
      })
      .command({
        command: "enable <selector>",
        describe: "Observe and reactivate one local member.",
        builder: (child) => child
          .positional("selector", { type: "string", demandOption: true })
          .option("yes", { type: "boolean", default: false })
          .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
        handler: (args) => handleMemberStateMutation("enabled", args as unknown as MemberMutationArgs, deps),
      })
      .command({
        command: "reset-password <selector>",
        describe: "Issue a protected one-time password-reset handoff.",
        builder: (child) => child
          .positional("selector", { type: "string", demandOption: true })
          .option("handoff-file", { type: "string", describe: "New absolute owner-only JSON destination" })
          .option("yes", { type: "boolean", default: false })
          .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
        handler: (args) => handleResetPassword(args as unknown as ResetPasswordArgs, deps),
      })
      .command({
        command: "remove <selector>",
        describe: "Plan or execute guarded permanent member removal.",
        builder: (child) => child
          .positional("selector", { type: "string", demandOption: true })
          .option("transfer-room", { type: "string", array: true, describe: "Resolve one blocker as room-id=new-owner-id" })
          .option("archive-room", { type: "string", array: true, describe: "Archive one blocking room by ID" })
          .option("yes", { type: "boolean", default: false, describe: "Execute the freshly observed removal plan" })
          .option("format", { type: "string", choices: ["human", "json"] as const, default: "human" }),
        handler: (args) => handleRemoveMember(args as unknown as RemoveMemberArgs, deps),
      })
      .demandCommand(1, 1)
      .strict(),
    handler: () => {},
  };
}

export const membersModule = createMembersModule();
