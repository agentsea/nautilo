import type { FastifyInstance } from "fastify";

import {
  PERSONAL_ENCRYPTION_COVERAGE_FAMILIES,
  getEncryptionTransitionPolicy,
  readPersonalEncryptionCoverageFamily,
  type PersonalEncryptionCoverageFamily,
  type PersonalEncryptionCoverageFamilyResult,
} from "@nautilo/db";
import {
  personalEncryptionCoverageV1Schema,
  type PersonalEncryptionCoverageFamilyMeasurement,
} from "@nautilo/api-client";
import { findCurrentReadableNamespacesForHumanActor } from "@nautilo/trust";

import { getServerDirectDb } from "../lib/server-direct-db";

type CoveragePolicy = Readonly<{
  mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
}>;

export interface PersonalEncryptionCoverageRouteDeps {
  getDb?: typeof getServerDirectDb;
  getPolicy?: (db: ReturnType<typeof getServerDirectDb>) => Promise<CoveragePolicy>;
  getReadableNamespaces?: typeof findCurrentReadableNamespacesForHumanActor;
  getFamilyCoverage?: typeof readPersonalEncryptionCoverageFamily;
  now?: () => Date;
}

function unavailableFamily(
  family: PersonalEncryptionCoverageFamily,
): PersonalEncryptionCoverageFamilyMeasurement {
  return {
    family,
    measurement: "unavailable",
    accessible: null,
    plaintextPresent: null,
    encryptedCounterpart: null,
  };
}

function serializeFamily(
  result: PersonalEncryptionCoverageFamilyResult,
): PersonalEncryptionCoverageFamilyMeasurement {
  if (result.measurement === "unsupported") {
    return {
      family: result.family,
      measurement: "unsupported",
      accessible: result.accessible.toString(),
      plaintextPresent: result.plaintextPresent.toString(),
      encryptedCounterpart: null,
    };
  }
  return {
    family: result.family,
    measurement: "measured",
    accessible: result.accessible.toString(),
    plaintextPresent: result.plaintextPresent.toString(),
    encryptedCounterpart: result.encryptedCounterpart.toString(),
  };
}

/** M308 — authenticated, aggregate-only personal encryption coverage. */
export function personalEncryptionCoverageRoutes(
  app: FastifyInstance,
  overrides: PersonalEncryptionCoverageRouteDeps = {},
): void {
  const getDb = overrides.getDb ?? getServerDirectDb;
  const getPolicy = overrides.getPolicy ?? getEncryptionTransitionPolicy;
  const getReadableNamespaces = overrides.getReadableNamespaces
    ?? findCurrentReadableNamespacesForHumanActor;
  const getFamilyCoverage = overrides.getFamilyCoverage
    ?? readPersonalEncryptionCoverageFamily;
  const now = overrides.now ?? (() => new Date());

  app.get("/api/encryption/coverage/me", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Vary", "Authorization");

    const userId = request.sessionUserId;
    const humanActorId = request.sessionActorId;
    if (!userId || !humanActorId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (Object.keys(request.query as Record<string, unknown>).length > 0) {
      return reply.code(400).send({ error: "Query parameters are not supported" });
    }

    let policy: CoveragePolicy;
    try {
      policy = await getPolicy(getDb());
    } catch {
      return reply.code(503).send({ error: "Encryption coverage unavailable" });
    }
    if (policy.mode === "plaintext_only") {
      return reply.send(personalEncryptionCoverageV1Schema.parse({
        dtoVersion: 1,
        policy: "plaintext_only",
        computedAt: null,
        families: [],
      }));
    }

    let readableNamespaceIds: readonly string[];
    try {
      readableNamespaceIds = await getReadableNamespaces(humanActorId);
    } catch {
      const task = await getFamilyCoverage(getDb(), {
        family: "task",
        readableNamespaceIds: [],
        userId,
      }).then(serializeFamily, () => unavailableFamily("task"));
      const families = PERSONAL_ENCRYPTION_COVERAGE_FAMILIES.map((family) =>
        family === "task" ? task : unavailableFamily(family)
      );
      return reply.send(personalEncryptionCoverageV1Schema.parse({
        dtoVersion: 1,
        policy: policy.mode,
        computedAt: now().toISOString(),
        families,
      }));
    }

    const db = getDb();
    const settled = await Promise.allSettled(
      PERSONAL_ENCRYPTION_COVERAGE_FAMILIES.map((family) =>
        getFamilyCoverage(db, { family, readableNamespaceIds, userId })
      ),
    );
    const families = settled.map((result, index) => {
      const family = PERSONAL_ENCRYPTION_COVERAGE_FAMILIES[index]!;
      return result.status === "fulfilled"
        ? serializeFamily(result.value)
        : unavailableFamily(family);
    });
    return reply.send(personalEncryptionCoverageV1Schema.parse({
      dtoVersion: 1,
      policy: policy.mode,
      computedAt: now().toISOString(),
      families,
    }));
  });
}
