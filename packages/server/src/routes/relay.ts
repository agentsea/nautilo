/**
 * M056 — Relay device pairing + management HTTP routes.
 *
 * - `POST /api/relay/pair` mints a long-lived opaque relay token for
 *   the calling user's actor. Plaintext is returned ONCE; the server
 *   only stores `sha256(token)`.
 * - `GET /api/relay/devices` lists the user's active devices.
 * - `DELETE /api/relay/devices/:id` revokes a device (silent 204
 *   either way to hide cross-user existence).
 *
 * Naming: this plugin is exported as `relayHttpRoutes` to avoid
 * colliding with the WS-side `relayRoutes(app, registry)` exported
 * from `realtime/relay-endpoint.ts` — both are registered next to
 * each other in `app.ts`. None of these routes are in
 * `PUBLIC_ROUTES`; they require a real authenticated context
 * decorated by the M052 trust preHandler.
 */

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { warn } from "@nautilo/logger";
import { getRelayTokenStore } from "../lib/relay-token-store";
import type { RelayPairingLifecycleAuditEvent } from "../lib/security-audit-log";
import { RELAY_TOKEN_PREFIX, validateRelayToken } from "../realtime/relay-token";
import { getElectronOriginCredentialStore } from "../remote-control/electron-origin-credential-store";

const MAX_LABEL_LENGTH = 200;
const TOKEN_RANDOM_BYTES = 24; // 24 bytes → 32 base64url chars → 192 bits

/** Generate a fresh plaintext token in the canonical `rty_` format. */
function mintRelayToken(): string {
  return RELAY_TOKEN_PREFIX + randomBytes(TOKEN_RANDOM_BYTES).toString("base64url");
}

/**
 * D418 — canonical UUID format for the optional `installationId`.
 * Case-insensitive, any UUID version. Missing/empty stays legacy;
 * a present-but-malformed value is a 400 with NO insert.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PairBody {
  deviceLabel?: unknown;
  capabilities?: unknown;
  installationId?: unknown;
  deviceGroupId?: unknown;
}

interface RevokeGroupedBody {
  expectedPairingCount?: unknown;
}

interface HistoricalCleanupBody {
  expectedPairingCount?: unknown;
  confirm?: unknown;
}

interface ElectronOrdinaryOriginBody {
  requestId?: unknown;
  relayId?: unknown;
  desktopSessionId?: unknown;
  method?: unknown;
  path?: unknown;
  bodySha256?: unknown;
}

export interface ElectronOriginRelayRegistry {
  getUserId(relayId: string): string | null | undefined;
  getDesktopSessionId(relayId: string): string | null | undefined;
  getPairingGeneration(relayId: string): string | null | undefined;
}

export interface RelayHttpRoutesDeps {
  /**
   * Owned by the realtime lifecycle lane. The HTTP mutation has committed
   * before this is called, and passes only server-side pairing generations.
   */
  reconcileRevokedPairingGenerations?: (args: {
    userId: string;
    pairingGenerationIds: readonly string[];
  }) => Promise<void> | void;
  /** Optional security-audit bridge supplied by app composition. */
  recordPairingLifecycleAudit?: (
    event: RelayPairingLifecycleAuditEvent,
  ) => Promise<void> | void;
  generationInvalidation?: RelayGenerationInvalidationPort;
  /** Sole live Relay registry used to bind Electron-main admissions. */
  relayRegistry?: ElectronOriginRelayRegistry;
}

const DEVICE_CONTRACT_VERSION = 2 as const;
const MAX_EXPECTED_PAIRING_COUNT = 500;
const DEVICE_MANAGEMENT_ID_RE = /^rdm_[A-Za-z0-9_-]{43}$/;

function parseExpectedPairingCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_EXPECTED_PAIRING_COUNT
    ? value
    : null;
}

function serializeGroupedDevice(device: {
  deviceManagementId: string;
  label: string;
  pairingCount: number;
  firstPairedAt: Date;
  lastSeenAt: Date | null;
  profiles: readonly string[];
  capabilities: readonly string[];
}) {
  return {
    deviceManagementId: device.deviceManagementId,
    label: device.label,
    pairingCount: device.pairingCount,
    firstPairedAt: device.firstPairedAt.toISOString(),
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    profiles: device.profiles,
    capabilities: device.capabilities,
  };
}

async function recordPairingLifecycleAudit(
  deps: RelayHttpRoutesDeps,
  event: RelayPairingLifecycleAuditEvent,
): Promise<boolean> {
  if (!deps.recordPairingLifecycleAudit) return false;
  try {
    await deps.recordPairingLifecycleAudit(event);
    return true;
  } catch (error) {
    warn(
      `[relay] lifecycle audit write failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * D458 wiring port.  It is intentionally server-only: revoked generation ids
 * are an authority detail and are never reflected in the silent device HTTP
 * response.  `RemoteHostPresenceStream.invalidatePairingGenerations` satisfies
 * this shape once the app composes its authoritative host projector.
 */
export interface RelayGenerationInvalidationPort {
  invalidatePairingGenerations(args: {
    userId: string;
    pairingGenerationIds: readonly string[];
  }): Promise<unknown>;
}

export function relayHttpRoutes(app: FastifyInstance, deps: RelayHttpRoutesDeps = {}): void {
  app.post<{ Body: ElectronOrdinaryOriginBody }>(
    "/api/relay/electron-origin-credential",
    async (request, reply) => {
      const userId = request.sessionUserId;
      const actorId = request.sessionActorId;
      if (!userId || !actorId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!deps.relayRegistry) {
        return reply.code(503).send({ error: "Desktop origin is unavailable" });
      }
      const relayTokenHeader = request.headers["x-nautilo-relay-token"];
      if (typeof relayTokenHeader !== "string" || relayTokenHeader.length > 128) {
        return reply.code(403).send({ error: "Desktop origin is unavailable" });
      }
      const validated = await validateRelayToken(relayTokenHeader);
      if (!validated || validated.userId !== userId || validated.actorId !== actorId) {
        return reply.code(403).send({ error: "Desktop origin is unavailable" });
      }
      const body = request.body ?? {};
      if (
        typeof body.requestId !== "string" || !UUID_RE.test(body.requestId) ||
        typeof body.relayId !== "string" || body.relayId.length < 1 || body.relayId.length > 200 ||
        typeof body.desktopSessionId !== "string" || !UUID_RE.test(body.desktopSessionId) ||
        body.method !== "POST" ||
        typeof body.path !== "string" || body.path.length < 1 || body.path.length > 1024 ||
        !body.path.startsWith("/api/rooms/") || !body.path.endsWith("/messages") ||
        body.path.includes("?") || body.path.includes("#") ||
        typeof body.bodySha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.bodySha256)
      ) {
        return reply.code(400).send({ error: "Invalid desktop origin request" });
      }
      if (
        deps.relayRegistry.getUserId(body.relayId) !== userId ||
        deps.relayRegistry.getDesktopSessionId(body.relayId) !== body.desktopSessionId ||
        deps.relayRegistry.getPairingGeneration(body.relayId) !== validated.tokenId
      ) {
        return reply.code(403).send({ error: "Desktop origin is unavailable" });
      }
      const issued = getElectronOriginCredentialStore().issue({
        requestId: body.requestId.toLowerCase(),
        userId,
        actorId,
        relayId: body.relayId,
        desktopSessionId: body.desktopSessionId.toLowerCase(),
        pairingGeneration: validated.tokenId,
        method: body.method,
        path: body.path,
        bodySha256: body.bodySha256,
      });
      return reply.send({ credential: issued.token, expiresAt: issued.expiresAt.toISOString() });
    },
  );

  app.post<{ Body: PairBody }>("/api/relay/pair", async (request, reply) => {
    const userId = request.sessionUserId;
    const actorId = request.sessionActorId;
    if (!userId || !actorId) {
      return reply.code(401).send({ error: "Sign in to pair a device" });
    }

    const body = request.body ?? {};
    const labelRaw = typeof body.deviceLabel === "string" ? body.deviceLabel.trim() : "";
    const label = labelRaw.length > 0 ? labelRaw : "Unnamed device";
    if (label.length > MAX_LABEL_LENGTH) {
      return reply
        .code(400)
        .send({ error: `deviceLabel too long (max ${MAX_LABEL_LENGTH} chars)` });
    }

    const capabilities =
      body.capabilities !== null &&
      typeof body.capabilities === "object" &&
      !Array.isArray(body.capabilities)
        ? (body.capabilities as Record<string, unknown>)
        : {};

    // D418 — `installationId` is an OPTIONAL opaque UUID. Missing
    // (or empty) stays legacy: plain insertToken, no revocation, and
    // legacy rows MAY legitimately duplicate. A present-but-invalid
    // value fails fast with 400 and NO row is inserted.
    const installationRaw = body.installationId;
    const installationPresent =
      installationRaw !== undefined &&
      installationRaw !== null &&
      (typeof installationRaw !== "string" || installationRaw.trim().length > 0);
    let installationId: string | null = null;
    if (installationPresent) {
      if (typeof installationRaw !== "string" || !UUID_RE.test(installationRaw.trim())) {
        return reply
          .code(400)
          .send({ error: "installationId must be a UUID or omitted" });
      }
      installationId = installationRaw.trim();
    }

    // D480 — this opaque UUID is grouping-only. Its absence is a supported
    // legacy path; a present malformed value fails rather than falling back
    // to the mutable label/hostname.
    const groupRaw = body.deviceGroupId;
    let deviceGroupId: string | null = null;
    if (groupRaw !== undefined && groupRaw !== null) {
      if (typeof groupRaw !== "string" || !UUID_RE.test(groupRaw.trim())) {
        return reply.code(400).send({ error: "deviceGroupId must be a UUID or omitted" });
      }
      deviceGroupId = groupRaw.trim();
    }

    const token = mintRelayToken();
    const tokenHash = createHash("sha256").update(token).digest("hex");

    let revokedPairingGenerationIds: readonly string[] = [];
    try {
      if (installationId !== null) {
        const paired = await getRelayTokenStore().pairForInstallation({
          userId,
          actorId,
          tokenHash,
          label,
          capabilities,
          installationId,
          deviceGroupId,
        });
        revokedPairingGenerationIds = paired.revokedPairingGenerationIds ?? [];
      } else {
        await getRelayTokenStore().insertToken({
          userId,
          actorId,
          tokenHash,
          label,
          capabilities,
          deviceGroupId,
        });
      }
    } catch (err) {
      warn(
        `[relay] pair insert failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return reply.code(500).send({ error: "Failed to mint relay token" });
    }

    if (revokedPairingGenerationIds.length > 0 && deps.generationInvalidation) {
      try {
        await deps.generationInvalidation.invalidatePairingGenerations({
          userId,
          pairingGenerationIds: revokedPairingGenerationIds,
        });
      } catch (err) {
        // The durable token revocation has already committed.  Preserve the
        // public pair response and let the next registry reconciliation remove
        // stale presentation; do not expose internal generation detail.
        warn(
          `[relay] post-repair remote presence invalidation failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Plaintext is returned ONCE — never logged, never stored
    // server-side beyond the SHA-256 hash above.
    return reply.send({ relayToken: token, pairingContractVersion: DEVICE_CONTRACT_VERSION });
  });

  app.get("/api/relay/devices", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) {
      return reply.code(401).send({ error: "Sign in to list devices" });
    }
    const rows = await getRelayTokenStore().listForUser(userId);
    return reply.send(
      rows.map((r) => ({
        id: r.id,
        label: r.label,
        capabilities: r.capabilities,
        createdAt: r.createdAt.toISOString(),
        lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
      })),
    );
  });

  app.delete<{ Params: { id: string } }>(
    "/api/relay/devices/:id",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) {
        return reply.code(401).send({ error: "Sign in to revoke devices" });
      }
      // Cross-user revocations resolve to "no row updated" inside
      // `revokeForUser` because the WHERE clause anchors on userId.
      // We DELIBERATELY do not surface that distinction — silent 204
      // either way hides whether the id existed for someone else.
      const store = getRelayTokenStore();
      let revokedPairingGenerationIds: readonly string[] = [];
      if (store.revokeWithGenerationsForUser) {
        const result = await store.revokeWithGenerationsForUser({
          id: request.params.id,
          userId,
        });
        revokedPairingGenerationIds = result.revokedPairingGenerationIds;
      } else {
        await store.revokeForUser({ id: request.params.id, userId });
      }
      if (revokedPairingGenerationIds.length > 0 && deps.generationInvalidation) {
        try {
          await deps.generationInvalidation.invalidatePairingGenerations({
            userId,
            pairingGenerationIds: revokedPairingGenerationIds,
          });
        } catch (err) {
          warn(
            `[relay] post-revoke remote presence invalidation failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      return reply.code(204).send();
    },
  );

  // D480 v2 is additive: keep the token-row-shaped v1 endpoints above for
  // older Workbench/mobile clients while new clients get a truthful physical
  // device projection and one bounded historical summary.
  app.get("/api/relay/devices/v2", async (request, reply) => {
    const userId = request.sessionUserId;
    if (!userId) return reply.code(401).send({ error: "Sign in to list devices" });
    const result = await getRelayTokenStore().listGroupedForUser!(userId);
    return reply.send({
      contractVersion: DEVICE_CONTRACT_VERSION,
      devices: result.devices.map(serializeGroupedDevice),
      historical: {
        pairingCount: result.historical.activeCount,
        oldestPairedAt: result.historical.oldestPairedAt?.toISOString() ?? null,
        latestSeenAt: result.historical.latestSeenAt?.toISOString() ?? null,
      },
    });
  });

  app.get<{ Params: { deviceManagementId: string } }>(
    "/api/relay/devices/v2/:deviceManagementId",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) return reply.code(401).send({ error: "Sign in to list devices" });
      if (!DEVICE_MANAGEMENT_ID_RE.test(request.params.deviceManagementId)) {
        return reply.code(400).send({ error: "Invalid device management target" });
      }
      const result = await getRelayTokenStore().listGroupedForUser!(userId);
      const device = result.devices.find((candidate) => candidate.deviceManagementId === request.params.deviceManagementId);
      // 404 remains intentionally non-descriptive: it covers a stale target
      // and another user's opaque target alike.
      if (!device) return reply.code(404).send({ error: "Device not found" });
      return reply.send({ contractVersion: DEVICE_CONTRACT_VERSION, device: serializeGroupedDevice(device) });
    },
  );

  app.delete<{ Params: { deviceManagementId: string }; Body: RevokeGroupedBody }>(
    "/api/relay/devices/v2/:deviceManagementId",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) return reply.code(401).send({ error: "Sign in to revoke devices" });
      if (!DEVICE_MANAGEMENT_ID_RE.test(request.params.deviceManagementId)) {
        return reply.code(400).send({ error: "Invalid device management target" });
      }
      const expectedPairingCount = parseExpectedPairingCount(request.body?.expectedPairingCount);
      if (expectedPairingCount === null) {
        return reply.code(400).send({ error: "expectedPairingCount must be a bounded non-negative integer" });
      }
      const result = await getRelayTokenStore().revokeGroupedForUser!({
        userId,
        deviceManagementId: request.params.deviceManagementId,
        expectedPairingCount,
      });
      const outcome = !result.matched ? "not_found" : !result.current ? "stale" : "revoked";
      const auditEvent = {
        ts: new Date().toISOString(),
        actorId: request.sessionActorId ?? null,
        ip: request.ip,
        userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined,
        kind: "relay_pairing_lifecycle",
        userId,
        operation: "group_revoke",
        managementTarget: request.params.deviceManagementId,
        affectedPairingCount: result.affectedPairingCount,
        result: outcome === "revoked" ? "succeeded" : outcome === "stale" ? "stale" : "not_found_or_foreign",
        reason: outcome === "revoked" ? "revoked" : outcome === "stale" ? "confirmation_mismatch" : "not_found_or_foreign",
        correlationId: request.id,
      } satisfies RelayPairingLifecycleAuditEvent;
      if (result.matched && result.current) {
        await deps.reconcileRevokedPairingGenerations?.({
          userId,
          pairingGenerationIds: result.revokedPairingGenerationIds,
        });
      }
      const auditRecorded = await recordPairingLifecycleAudit(deps, auditEvent);
      if (!result.matched) return reply.code(204).send();
      if (!result.current) return reply.code(409).send({ error: "Device changed; refresh and confirm again" });
      return reply.send({
        affectedPairingCount: result.affectedPairingCount,
        auditRecorded,
      });
    },
  );

  app.post<{ Body: HistoricalCleanupBody }>(
    "/api/relay/devices/v2/historical/cleanup",
    async (request, reply) => {
      const userId = request.sessionUserId;
      if (!userId) return reply.code(401).send({ error: "Sign in to revoke devices" });
      if (request.body?.confirm !== true) {
        return reply.code(400).send({ error: "confirm must be true to clean historical pairings" });
      }
      const expectedPairingCount = parseExpectedPairingCount(request.body.expectedPairingCount);
      if (expectedPairingCount === null) {
        return reply.code(400).send({ error: "expectedPairingCount must be a bounded non-negative integer" });
      }
      const result = await getRelayTokenStore().cleanupHistoricalForUser!({ userId, expectedPairingCount });
      const outcome = !result.matched ? "not_found" : !result.current ? "stale" : "revoked";
      const auditEvent = {
        ts: new Date().toISOString(),
        actorId: request.sessionActorId ?? null,
        ip: request.ip,
        userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined,
        kind: "relay_pairing_lifecycle",
        userId,
        operation: "historical_cleanup",
        managementTarget: "historical",
        affectedPairingCount: result.affectedPairingCount,
        result: outcome === "revoked" ? "succeeded" : outcome === "stale" ? "stale" : "not_found_or_foreign",
        reason: outcome === "revoked" ? "revoked" : outcome === "stale" ? "confirmation_mismatch" : "not_found_or_foreign",
        correlationId: request.id,
      } satisfies RelayPairingLifecycleAuditEvent;
      if (result.matched && result.current) {
        await deps.reconcileRevokedPairingGenerations?.({
          userId,
          pairingGenerationIds: result.revokedPairingGenerationIds,
        });
      }
      const auditRecorded = await recordPairingLifecycleAudit(deps, auditEvent);
      if (!result.matched) return reply.code(204).send();
      if (!result.current) return reply.code(409).send({ error: "Historical pairings changed; refresh and confirm again" });
      return reply.send({
        affectedPairingCount: result.affectedPairingCount,
        auditRecorded,
      });
    },
  );
}
