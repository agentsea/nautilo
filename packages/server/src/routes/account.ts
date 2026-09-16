import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { isLoopbackHostname } from "@nautilo/config/loopback-origin";
import { passwordRecoveryUsesOssRelay } from "@nautilo/config";
import { isLocalhostIp } from "@nautilo/config-guard";
import { error as logError, log, warn } from "@nautilo/logger";
import {
  db,
  eq,
  getAccountSecurityRowByUserId,
  markPasswordChangeCompleted,
  users,
} from "@nautilo/db";
import {
  type PinChallengeProvider,
  getLogtoAdminClient,
  getLogtoAccountRecoveryCodeStatus,
  markLogtoAccountRecoveryCodeUsed,
  regenerateLogtoAccountRecoveryCodes,
} from "@nautilo/trust";
import { ACCOUNT_SECURITY_AUDIT } from "../lib/account-security-audit";
import { requireFreshLogtoAccessToken } from "../lib/logto-freshness";
import { executeLogtoPasswordChange } from "../lib/logto-account-password-change";
import { openLogtoRecoverySession } from "../lib/logto-recover-with-code";
import {
  consumeCodeForSession,
  consumedRecoverySessionBelongsToUser,
} from "../lib/logto-recovery-session";
import type { SecurityAuditEvent } from "../lib/security-audit-log";
import {
  assessAccountDeletion,
  AccountDeletionIneligibleError,
  deleteLocalUserAccount,
  type AccountDeletionEligibility,
} from "../lib/user-account-deletion";
import { HANDLE_RE } from "@nautilo/types";

const RECOVER_RATE_WINDOW_MS = 15 * 60 * 1000;
const RECOVER_RATE_MAX = 24;
const recoverAttemptByIp = new Map<string, { n: number; resetAt: number }>();

export interface AccountRouteDeps {
  pinProvider?: PinChallengeProvider | undefined;
  markRecoveryCodeUsed?: (args: {
    userId: string;
    recoveryCodeRowId: string;
  }) => Promise<boolean>;
  markPasswordRecoveryCompleted?: (userId: string) => Promise<boolean>;
  /**
   * M120 — JSONL security-audit sink. When omitted (tests / non-audited
   * contexts) recovery events are simply not written; the route still works.
   * Matches the app-level writer, which returns a resolved Promise.
   */
  auditEvent?: ((event: SecurityAuditEvent) => void | Promise<void>) | undefined;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestUserAgent(request: FastifyRequest): string | undefined {
  const ua = request.headers["user-agent"];
  return typeof ua === "string" ? ua : undefined;
}

function publicBaseUrlIsUnsetOrLoopback(): boolean {
  const raw = process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim();
  if (!raw) return true;
  try {
    return isLoopbackHostname(new URL(raw).hostname);
  } catch {
    return false;
  }
}

function requestHostIsLoopback(request: FastifyRequest): boolean {
  const host = request.headers.host;
  if (typeof host !== "string" || host.trim().length === 0) return false;
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function isPrivateNetworkIp(ip: string): boolean {
  if (/^10\./u.test(ip)) return true;
  if (/^192\.168\./u.test(ip)) return true;
  const m = ip.match(/^172\.(\d{1,2})\./u);
  if (m) {
    const n = Number(m[1]);
    return n >= 16 && n <= 31;
  }
  if (ip.startsWith("::ffff:")) {
    return isPrivateNetworkIp(ip.slice("::ffff:".length));
  }
  return false;
}

function requestAllowsLocalPasswordRecovery(request: FastifyRequest): boolean {
  if (isLocalhostIp(request.ip)) return true;
  // In local compose, browser/Electron requests enter the container from the
  // Docker bridge, not 127.0.0.1. Treat that as local only when the browser's
  // Host is loopback AND this server is not configured with a public base URL.
  return (
    isPrivateNetworkIp(request.ip) &&
    publicBaseUrlIsUnsetOrLoopback() &&
    requestHostIsLoopback(request)
  );
}

/** M120 — kind-specific fields for the recovery audit rows (common envelope added by the emitter). */
type RecoveryAuditCore =
  | { kind: "recovery_session_opened"; handleHash: string }
  | {
      kind: "recovery_session_rejected";
      handleHash: string;
      reason:
        | "reject"
        | "logto_unavailable"
        | "logto_endpoint_missing"
        | "unexpected_error";
    }
  | { kind: "recovery_relay_read_denied"; reason: "not_found" | "bad_request" }
  | { kind: "recovery_relay_code_unmatched" };

function recoverFailuresExceeded(ip: string): boolean {
  const now = Date.now();
  if (recoverAttemptByIp.size > 2000) {
    for (const [key, v] of recoverAttemptByIp) {
      if (now > v.resetAt) recoverAttemptByIp.delete(key);
    }
  }
  const cur = recoverAttemptByIp.get(ip);
  if (!cur || now > cur.resetAt) return false;
  return cur.n >= RECOVER_RATE_MAX;
}

function recoverRecordFailure(ip: string): void {
  const now = Date.now();
  const cur = recoverAttemptByIp.get(ip);
  if (!cur || now > cur.resetAt) {
    recoverAttemptByIp.set(ip, { n: 1, resetAt: now + RECOVER_RATE_WINDOW_MS });
    return;
  }
  cur.n += 1;
}

async function loadUserLogtoLinkState(userId: string): Promise<{
  userRow: { externalId: string | null; server: string | null } | undefined;
  linkedToLogto: boolean;
  logtoUserId: string | null;
}> {
  const [userRow] = await db
    .select({
      externalId: users.externalId,
      server: users.server,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!userRow) {
    return { userRow: undefined, linkedToLogto: false, logtoUserId: null };
  }

  const linkedToLogto =
    userRow.server === null &&
    userRow.externalId !== null &&
    userRow.externalId.length > 0;

  return {
    userRow,
    linkedToLogto,
    logtoUserId: linkedToLogto ? userRow.externalId! : null,
  };
}

/**
 * D104 — authenticated account metadata for Logto-linked users.
 */
export function accountRoutes(app: FastifyInstance, deps: AccountRouteDeps = {}) {
  const markRecoveryCodeUsed =
    deps.markRecoveryCodeUsed ??
    ((args: { userId: string; recoveryCodeRowId: string }) =>
      markLogtoAccountRecoveryCodeUsed(args.userId, args.recoveryCodeRowId));
  const markPasswordRecoveryCompleted =
    deps.markPasswordRecoveryCompleted ??
    ((userId: string) => markPasswordChangeCompleted(db, userId));

  const emitRecoveryAudit = (
    request: FastifyRequest,
    core: RecoveryAuditCore,
  ): void => {
    if (!deps.auditEvent) return;
    // Fire-and-forget: the writer is durable-best-effort and must not block
    // the response. `void` because the app-level writer returns a Promise.
    void deps.auditEvent({
      ts: new Date().toISOString(),
      actorId: null,
      ip: request.ip,
      userAgent: requestUserAgent(request),
      ...core,
    });
  };

  const sendDeletionIneligibility = (
    reply: FastifyReply,
    eligibility: Exclude<AccountDeletionEligibility, { eligible: true }>,
  ) => {
    if (eligibility.code === "user_not_found") {
      return reply.code(404).send({ eligible: false, code: eligibility.code });
    }
    if (eligibility.code === "federated_user") {
      return reply.code(422).send(eligibility);
    }
    return reply.code(409).send(eligibility);
  };

  app.get("/api/account/deletion/eligibility", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const eligibility = await assessAccountDeletion(userId);
    return reply.send(eligibility);
  });

  app.delete("/api/account", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const body = request.body as Record<string, unknown> | undefined;
    if (body?.["confirmation"] !== "DELETE MY ACCOUNT") {
      return reply.code(400).send({
        error: "confirmation_required",
        code: "confirmation_required",
      });
    }
    if (await requireFreshLogtoAccessToken(request, reply)) return;

    const eligibility = await assessAccountDeletion(userId);
    if (!eligibility.eligible) {
      return sendDeletionIneligibility(reply, eligibility);
    }

    try {
      const deletion = await deleteLocalUserAccount(userId);
      if (deps.auditEvent) {
        void deps.auditEvent({
          ts: new Date().toISOString(),
          kind: "user_deleted",
          actorId: request.sessionActorId,
          targetUserId: userId,
          logtoRevoked: deletion.logtoRevoked,
          ip: request.ip,
          userAgent: requestUserAgent(request),
        } as SecurityAuditEvent);
      }
      return reply.send({
        ok: true,
        logtoRevoked: deletion.logtoRevoked,
        reconciliationPending: !deletion.logtoRevoked,
      });
    } catch (error) {
      if (error instanceof AccountDeletionIneligibleError) {
        return sendDeletionIneligibility(reply, error.eligibility);
      }
      logError(
        "[account] DELETE /api/account failed:",
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      return reply.code(500).send({ error: "account_deletion_failed" });
    }
  });

  app.get("/api/account/security", async (request, reply) => {
    try {
      const userId = request.sessionUserId;
      if (!userId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const { userRow, linkedToLogto } = await loadUserLogtoLinkState(userId);

      if (!userRow) {
        return reply.code(404).send({ error: "User not found" });
      }

      if (!linkedToLogto) {
        return reply.send({
          linkedToLogto: false,
          requiresPasswordChange: false,
          passwordChangeReason: null,
          requiredSince: null,
          completedAt: null,
          logtoRecoveryCodes: null,
        });
      }

      const sec = await getAccountSecurityRowByUserId(db, userId);
      const rc = await getLogtoAccountRecoveryCodeStatus(userId);

      const base = {
        linkedToLogto: true,
        requiresPasswordChange: sec?.requiresPasswordChange ?? false,
        passwordChangeReason: sec?.passwordChangeReason ?? null,
        requiredSince: sec?.requiredSince?.toISOString() ?? null,
        completedAt: sec?.completedAt?.toISOString() ?? null,
        logtoRecoveryCodes: {
          remaining: rc.remaining,
          total: rc.total,
          lastGeneratedAt: rc.lastGeneratedAt?.toISOString() ?? null,
        },
      };

      return reply.send(base);
    } catch (e) {
      logError(
        "[account] GET /api/account/security failed:",
        e instanceof Error ? e.stack ?? e.message : String(e),
      );
      return reply.code(500).send({ error: "Failed to load account security." });
    }
  });

  app.get("/api/account/recovery-codes/status", async (request, reply) => {
    try {
      const userId = request.sessionUserId;
      if (!userId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const { linkedToLogto } = await loadUserLogtoLinkState(userId);
      if (!linkedToLogto) {
        return reply.code(400).send({
          error: "This account is not linked to Logto.",
        });
      }

      const rc = await getLogtoAccountRecoveryCodeStatus(userId);
      log(
        `[account] ${ACCOUNT_SECURITY_AUDIT.LOGTO_RECOVERY_CODES_STATUS} userId=${userId}`,
      );
      return reply.send({
        remaining: rc.remaining,
        total: rc.total,
        lastGeneratedAt: rc.lastGeneratedAt?.toISOString() ?? null,
      });
    } catch (e) {
      logError(
        "[account] GET /api/account/recovery-codes/status failed:",
        e instanceof Error ? e.stack ?? e.message : String(e),
      );
      return reply.code(500).send({ error: "Failed to load recovery code status." });
    }
  });

  app.post("/api/account/recovery-codes/regenerate", async (request, reply) => {
    try {
      const userId = request.sessionUserId;
      if (!userId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const { linkedToLogto, logtoUserId } = await loadUserLogtoLinkState(userId);
      if (!linkedToLogto || !logtoUserId) {
        return reply.code(400).send({
          error: "This account is not linked to Logto.",
        });
      }

      const body = request.body as Record<string, unknown> | undefined;
      const pin = body?.["pin"];
      let reverified = false;

      if (typeof pin === "string" && pin.length > 0 && deps.pinProvider) {
        reverified = await deps.pinProvider.verifyProof(userId, pin);
      } else {
        if (await requireFreshLogtoAccessToken(request, reply)) return;
        reverified = true;
      }

      if (!reverified) {
        return reply.code(401).send({ error: "Identity re-verification failed." });
      }

      const codes = await regenerateLogtoAccountRecoveryCodes(userId);
      warn(
        `[account] ${ACCOUNT_SECURITY_AUDIT.LOGTO_RECOVERY_CODES_REGENERATED} userId=${userId}`,
      );
      return reply.send({ recoveryCodes: codes });
    } catch (e) {
      logError(
        "[account] POST /api/account/recovery-codes/regenerate failed:",
        e instanceof Error ? e.stack ?? e.message : String(e),
      );
      return reply
        .code(500)
        .send({ error: "Failed to regenerate recovery codes." });
    }
  });

  app.post("/api/account/password/recover-with-code", async (request, reply) => {
    const generic = {
      error: "Recovery request could not be completed.",
    } as const;

    if (!passwordRecoveryUsesOssRelay()) {
      return reply.code(404).send(generic);
    }

    if (!requestAllowsLocalPasswordRecovery(request)) {
      return reply.code(403).send({
        error: "Password recovery with a code is only allowed from localhost.",
      });
    }

    if (recoverFailuresExceeded(request.ip)) {
      return reply.code(429).send(generic);
    }

    const body = request.body as Record<string, unknown> | undefined;
    const handleRaw = body?.["handle"];
    const recoveryCode = body?.["recoveryCode"];
    // M120: `newPassword` is intentionally NOT read. Nautilo no longer sets
    // the password; the new password is collected by Logto's hosted page. A
    // stale client that still sends `newPassword` is tolerated (ignored), not
    // rejected, to avoid bricking mid-rollout clients.

    let handle: string;
    if (typeof handleRaw === "string" && handleRaw.trim().length > 0) {
      handle = handleRaw.trim().toLowerCase();
      if (!HANDLE_RE.test(handle)) {
        recoverRecordFailure(request.ip);
        return reply.code(400).send(generic);
      }
    } else {
      recoverRecordFailure(request.ip);
      return reply.code(400).send(generic);
    }

    if (typeof recoveryCode !== "string" || recoveryCode.trim().length === 0) {
      recoverRecordFailure(request.ip);
      return reply.code(400).send(generic);
    }

    const handleHash = sha256Hex(handle);

    const logtoEndpoint = process.env["LOGTO_ENDPOINT"]?.trim();
    if (!logtoEndpoint) {
      recoverRecordFailure(request.ip);
      emitRecoveryAudit(request, {
        kind: "recovery_session_rejected",
        handleHash,
        reason: "logto_endpoint_missing",
      });
      return reply.code(502).send(generic);
    }

    try {
      const result = await openLogtoRecoverySession({
        handle,
        recoveryCode: recoveryCode.trim(),
        admin: getLogtoAdminClient(),
        logtoEndpoint,
      });

      if (result.outcome === "success") {
        log(`[account] ${ACCOUNT_SECURITY_AUDIT.PASSWORD_RECOVERED} channel=recovery_code_relay`);
        emitRecoveryAudit(request, { kind: "recovery_session_opened", handleHash });
        return reply.send({
          ok: true,
          sessionId: result.sessionId,
          sessionToken: result.sessionToken,
          resetUrl: result.resetUrl,
          email: result.email,
        });
      }
      if (result.outcome === "logto_unavailable") {
        recoverRecordFailure(request.ip);
        emitRecoveryAudit(request, {
          kind: "recovery_session_rejected",
          handleHash,
          reason: "logto_unavailable",
        });
        return reply.code(502).send(generic);
      }
      recoverRecordFailure(request.ip);
      emitRecoveryAudit(request, {
        kind: "recovery_session_rejected",
        handleHash,
        reason: "reject",
      });
      return reply.code(400).send(generic);
    } catch (e) {
      recoverRecordFailure(request.ip);
      emitRecoveryAudit(request, {
        kind: "recovery_session_rejected",
        handleHash,
        reason: "unexpected_error",
      });
      logError(
        "[account] POST /api/account/password/recover-with-code failed:",
        e instanceof Error ? e.stack ?? e.message : String(e),
      );
      return reply.code(500).send(generic);
    }
  });

  /**
   * M120 — relay-read endpoint. After `recover-with-code` returns a session,
   * the client polls here with `Authorization: Bearer <sessionToken>` to
   * receive the Logto ForgotPassword verification code once Logto has
   * delivered it through the HTTP Email connector. The code is released ONLY
   * to the holder of the session token; a bare `sessionId` is insufficient.
   */
  app.get(
    "/api/account/password/recovery-relay/:sessionId",
    async (request, reply) => {
      const generic = { error: "Recovery request could not be completed." } as const;

      if (!passwordRecoveryUsesOssRelay()) {
        return reply.code(404).send(generic);
      }

      if (!requestAllowsLocalPasswordRecovery(request)) {
        return reply.code(403).send({
          error: "Password recovery with a code is only allowed from localhost.",
        });
      }
      if (recoverFailuresExceeded(request.ip)) {
        return reply.code(429).send(generic);
      }

      const sessionId = (request.params as { sessionId?: string } | undefined)?.sessionId;
      const authorization = request.headers.authorization;
      const prefix = "Bearer ";
      if (
        typeof sessionId !== "string" ||
        sessionId.length === 0 ||
        typeof authorization !== "string" ||
        !authorization.startsWith(prefix)
      ) {
        recoverRecordFailure(request.ip);
        emitRecoveryAudit(request, {
          kind: "recovery_relay_read_denied",
          reason: "bad_request",
        });
        return reply.code(400).send(generic);
      }
      const sessionToken = authorization.slice(prefix.length).trim();

      const result = consumeCodeForSession(sessionId, sessionToken);
      if (result.status === "not_found") {
        recoverRecordFailure(request.ip);
        emitRecoveryAudit(request, {
          kind: "recovery_relay_read_denied",
          reason: "not_found",
        });
        return reply.code(404).send(generic);
      }
      if (result.status === "pending") {
        return reply.send({ status: "pending" });
      }
      if (result.firstRead) {
        const consumed = await markRecoveryCodeUsed({
          userId: result.userId,
          recoveryCodeRowId: result.recoveryCodeRowId,
        });
        if (!consumed) {
          recoverRecordFailure(request.ip);
          emitRecoveryAudit(request, {
            kind: "recovery_relay_read_denied",
            reason: "not_found",
          });
          return reply.code(404).send(generic);
        }
      }
      return reply.send({ status: "ready", code: result.code });
    },
  );

  app.post("/api/account/password/recovery-completed", async (request, reply) => {
    try {
      const userId = request.sessionUserId;
      if (!userId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const body = request.body as Record<string, unknown> | undefined;
      const sessionId = body?.["sessionId"];
      const sessionToken = body?.["sessionToken"];
      if (
        typeof sessionId !== "string" ||
        sessionId.length === 0 ||
        typeof sessionToken !== "string" ||
        sessionToken.length === 0
      ) {
        return reply.code(400).send({ error: "Recovery session proof is required." });
      }
      if (
        !consumedRecoverySessionBelongsToUser({
          sessionId,
          sessionToken,
          userId,
        })
      ) {
        return reply.code(404).send({ error: "Recovery session not found or expired." });
      }
      await markPasswordRecoveryCompleted(userId);
      log(
        `[account] ${ACCOUNT_SECURITY_AUDIT.PASSWORD_RECOVERED} channel=recovery_code_relay_complete userId=${userId}`,
      );
      return reply.send({ ok: true });
    } catch (e) {
      logError(
        "[account] POST /api/account/password/recovery-completed failed:",
        e instanceof Error ? e.stack ?? e.message : String(e),
      );
      return reply.code(500).send({ error: "Failed to mark password recovery complete." });
    }
  });

  /**
   * D104 Phase 2 — signed-in Logto password change (current + new).
   * Requires a valid session and a Logto-linked user.
   */
  app.post("/api/account/password/change", async (request, reply) => {
    try {
      const userId = request.sessionUserId;
      if (!userId) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const body = request.body as Record<string, unknown> | undefined;
      const currentPassword = body?.["currentPassword"];
      const newPassword = body?.["newPassword"];
      const confirmPassword = body?.["confirmPassword"];

      if (
        typeof currentPassword !== "string" ||
        typeof newPassword !== "string"
      ) {
        return reply
          .code(400)
          .send({ error: "Request body must include currentPassword and newPassword strings." });
      }
      if (currentPassword.length === 0 || newPassword.length === 0) {
        return reply
          .code(400)
          .send({ error: "Passwords must be non-empty." });
      }
      if (confirmPassword !== undefined && confirmPassword !== null) {
        if (
          typeof confirmPassword !== "string" ||
          confirmPassword !== newPassword
        ) {
          return reply
            .code(400)
            .send({ error: "confirmPassword does not match newPassword." });
        }
      }

      const { userRow, linkedToLogto, logtoUserId } =
        await loadUserLogtoLinkState(userId);

      if (!userRow) {
        return reply.code(404).send({ error: "User not found" });
      }

      if (!linkedToLogto || !logtoUserId) {
        return reply.code(400).send({
          error: "This account is not linked to Logto; password cannot be changed here.",
        });
      }

      let changeResult;
      try {
        changeResult = await executeLogtoPasswordChange(
          getLogtoAdminClient(),
          logtoUserId,
          currentPassword,
          newPassword,
        );
      } catch (e) {
        warn(
          `[account] ${ACCOUNT_SECURITY_AUDIT.PASSWORD_CHANGE_FAILED} userId=${userId} phase=logto_verify_or_set`,
        );
        logError(
          "[account] POST /api/account/password/change Logto error:",
          e instanceof Error ? e.stack ?? e.message : String(e),
        );
        return reply.code(502).send({
          error: "The identity service is unavailable or rejected the request.",
        });
      }

      if (changeResult.outcome === "wrong_current") {
        warn(
          `[account] ${ACCOUNT_SECURITY_AUDIT.PASSWORD_CHANGE_REJECTED} userId=${userId} reason=wrong_current`,
        );
        return reply.code(422).send({ error: "Current password is incorrect." });
      }
      if (changeResult.outcome === "new_password_rejected") {
        warn(
          `[account] ${ACCOUNT_SECURITY_AUDIT.PASSWORD_CHANGE_REJECTED} userId=${userId} reason=policy`,
        );
        return reply.code(400).send({ error: changeResult.message });
      }
      if (changeResult.outcome === "logto_unavailable") {
        warn(
          `[account] ${ACCOUNT_SECURITY_AUDIT.PASSWORD_CHANGE_FAILED} userId=${userId} reason=upstream`,
        );
        return reply.code(502).send({ error: changeResult.message });
      }

      await markPasswordChangeCompleted(db, userId);
      log(
        `[account] ${ACCOUNT_SECURITY_AUDIT.PASSWORD_CHANGED} userId=${userId}`,
      );
      return reply.send({ ok: true });
    } catch (e) {
      logError(
        "[account] POST /api/account/password/change failed:",
        e instanceof Error ? e.stack ?? e.message : String(e),
      );
      return reply.code(500).send({ error: "Failed to change password." });
    }
  });
}
