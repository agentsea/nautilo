import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import type { DurableSleepClaim } from "@nautilo/reflection/durable";
import {
  BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH,
} from "@nautilo/runtime";
import {
  verifyCryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import {
  verifyRecordProductPostgresHandle,
} from "@nautilo/reflection-bridge/server";

import {
  releaseWaitingReflectionSemanticRequest,
} from "../../src/reflection/protected-authority-composition";

const NOW = 1_700_000_600_000;
const CLAIM: DurableSleepClaim = Object.freeze({
  logicalObjectRef: "logical:record",
  recordRef: "source:record",
  generation: 7,
  stage: "organization",
  changeReason: "created",
  leaseToken: "lease:current",
});
const WORK_ID = `reflection-semantic:${createHash("sha256")
  .update(JSON.stringify([
    "reflection-semantic/v2",
    "reflection.organization",
    CLAIM.recordRef,
    CLAIM.generation,
  ]))
  .digest("hex")}`;

type RequestState =
  | "awaiting_recipient"
  | "awaiting_device"
  | "grant_ready"
  | "claimed"
  | "running"
  | "publication_reconciliation"
  | "cancelled";

function requestRow(
  requestId: string,
  state: RequestState,
  recipientGeneration: number,
): Record<string, unknown> {
  const hasRecipient = !["awaiting_recipient", "cancelled"].includes(state);
  const hasDescriptor = state !== "awaiting_recipient";
  const descriptorBytes = new Uint8Array([2]);
  const hasGrant = ["grant_ready", "claimed", "running", "publication_reconciliation"]
    .includes(state);
  const hasClaim = ["claimed", "running", "publication_reconciliation"].includes(state);
  return {
    request_id: requestId,
    format_version: 2,
    work_identity_hash: new Uint8Array(32).fill(1),
    idempotency_key: requestId,
    work_id: WORK_ID,
    work_kind: "reflection.organization",
    purpose: "record.organize",
    namespace_id: "namespace:one",
    domain_id: "domain:one",
    credential_subject_kind: "processor",
    processor_kind: "reflection",
    processor_version: 1,
    processor_authorization_revision: null,
    agent_id: null,
    agent_runtime_generation: null,
    agent_authorization_revision: null,
    expected_domain_epoch: null,
    expected_namespace_access_revision: 1,
    expected_policy_revision: 1,
    recipient_generation: recipientGeneration,
    descriptor_hash: hasDescriptor
      ? createHash("sha256").update(descriptorBytes).digest()
      : null,
    descriptor_bytes: hasDescriptor ? descriptorBytes : null,
    recipient_key_id: hasRecipient ? `key:${requestId}` : null,
    recipient_public_key: hasRecipient ? new Uint8Array(65).fill(2) : null,
    recipient_expires_at_ms: hasRecipient ? NOW + 60_000 : null,
    accepted_response_kind: hasGrant ? "processor" : null,
    accepted_response_hash: hasGrant ? new Uint8Array(32).fill(3) : null,
    accepted_response_bytes: hasGrant ? new Uint8Array([1]) : null,
    credential_id: hasGrant ? `credential:${requestId}` : null,
    credential_hash: hasGrant ? new Uint8Array(32).fill(4) : null,
    issuing_human_id: hasGrant ? "human:one" : null,
    issuing_device_id: hasGrant ? "device:one" : null,
    issuing_device_authorization_revision: hasGrant ? 1 : null,
    issuer_signing_public_key_hash: hasGrant ? new Uint8Array(32).fill(5) : null,
    accepted_at_ms: hasGrant ? NOW - 1_000 : null,
    authorization_expires_at_ms: hasGrant ? NOW + 60_000 : null,
    request_revision: 3,
    state,
    claim_id: hasClaim ? `claim:${requestId}` : null,
    claim_expires_at_ms: hasClaim ? NOW + 30_000 : null,
    retry_count: 0,
    maximum_attempts: 8,
    last_retry_reason: null,
    next_attempt_at_ms: null,
    terminal_reason: state === "cancelled" ? "superseded" : null,
    finished_at_ms: state === "cancelled" ? NOW - 1 : null,
    created_at_ms: NOW - 10_000,
    updated_at_ms: NOW - 1_000,
    transform_commit_claim_id: null,
    transform_commit_descriptor_hash: null,
    transform_commit_recipient_generation: null,
    transform_commit_output_count: null,
    transform_committed_at: null,
  };
}

class Connection {
  constructor(
    readonly role: "nautilo" | "nautilo_crypto",
    readonly events: string[],
    readonly result: (
      statement: string,
      parameters: readonly unknown[],
    ) => readonly unknown[],
  ) {}

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.events.push(`${this.role}:${statement}`);
    if (statement.includes("current_user AS current_role")) {
      return Promise.resolve([{
        current_role: this.role,
        session_role: this.role,
      }] as Row[]);
    }
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{
        current_user: this.role,
        session_user: this.role,
      }] as Row[]);
    }
    return Promise.resolve(this.result(statement, parameters) as Row[]);
  }

  async transaction<Result>(use: (tx: this) => Promise<Result>): Promise<Result> {
    try {
      const result = await use(this);
      this.events.push(`${this.role}:commit`);
      return result;
    } catch (error) {
      this.events.push(`${this.role}:rollback`);
      throw error;
    }
  }
}

async function fixture(input: Readonly<{
  requests?: readonly Record<string, unknown>[];
  productRows?: readonly Record<string, unknown>[];
  failCas?: boolean;
}> = {}) {
  const events: string[] = [];
  const requests = (input.requests ?? []).map((row) => ({ ...row }));
  const productConnection = new Connection("nautilo", events, (statement, parameters) => {
    if (!statement.includes('from "reflection_record_semantic_work"')) return [];
    if (input.productRows !== undefined) return input.productRows;
    return parameters.includes(CLAIM.recordRef)
      && parameters.filter((value) => value === CLAIM.generation).length >= 2
      && parameters.includes(CLAIM.leaseToken)
      ? [{ record_id: CLAIM.recordRef }]
      : [];
  });
  const cryptoConnection = new Connection("nautilo_crypto", events, (statement, parameters) => {
    if (statement.includes('from "processor_crypto_signer_authorizations"')) return [];
    if (statement.startsWith('update "background_crypto_authorization_requests"')) {
      if (input.failCas === true) return [];
      const requestId = parameters.find((value) =>
        requests.some((row) => row["request_id"] === value));
      const row = requests.find((candidate) =>
        candidate["request_id"] === requestId);
      if (row === undefined) return [];
      Object.assign(row, {
        state: "cancelled",
        terminal_reason: "superseded",
        finished_at_ms: NOW,
        updated_at_ms: NOW,
        request_revision: Number(row["request_revision"]) + 1,
        recipient_key_id: null,
        recipient_public_key: null,
        recipient_expires_at_ms: null,
        claim_id: null,
        claim_expires_at_ms: null,
      });
      return [row];
    }
    if (statement.includes('from "background_crypto_authorization_requests"')) {
      const requestId = parameters.find((value) =>
        requests.some((row) => row["request_id"] === value));
      return requestId === undefined
        ? [...requests]
          .filter((row) => row["state"] !== "cancelled" || [
            row["transform_commit_claim_id"],
            row["transform_commit_descriptor_hash"],
            row["transform_commit_recipient_generation"],
            row["transform_commit_output_count"],
            row["transform_committed_at"],
          ].some((value) => value !== null))
          .sort((left, right) =>
            String(left["request_id"]).localeCompare(String(right["request_id"])))
          .slice(0, BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH)
        : requests.filter((row) => row["request_id"] === requestId);
    }
    return [];
  });
  return {
    events,
    requests,
    product: await verifyRecordProductPostgresHandle(productConnection),
    restricted: await verifyCryptoPostgresHandle(cryptoConnection),
  };
}

async function release(
  setup: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<Parameters<typeof releaseWaitingReflectionSemanticRequest>[0]> = {},
) {
  return releaseWaitingReflectionSemanticRequest({
    product: setup.product,
    restricted: setup.restricted,
    claim: CLAIM,
    stage: "organization",
    now: NOW,
    ...overrides,
  });
}

describe("Reflection semantic ordinary-fallback request release", () => {
  test("cancels only waiting recipient/device requests and returns exact generations", async () => {
    const setup = await fixture({ requests: [
      requestRow("request:recipient", "awaiting_recipient", 2),
      requestRow("request:device", "awaiting_device", 5),
    ] });
    expect(await release(setup)).toEqual([
      { requestId: "request:device", recipientGeneration: 5 },
      { requestId: "request:recipient", recipientGeneration: 2 },
    ]);
    expect(setup.requests.every((row) => row["state"] === "cancelled")).toBe(true);
  });

  test("requires the exact current claimed lease", async () => {
    for (const claim of [
      { ...CLAIM, leaseToken: "lease:stale" },
      { ...CLAIM, generation: CLAIM.generation + 1 },
    ]) {
      const setup = await fixture({ requests: [
        requestRow("request:waiting", "awaiting_device", 1),
      ] });
      expect(await release(setup, { claim })).toBeNull();
      expect(setup.events.some((event) =>
        event.includes('from "background_crypto_authorization_requests"'))).toBe(false);
    }
    const setup = await fixture({ productRows: [] });
    expect(await release(setup)).toBeNull();
    const claimQuery = setup.events.find((event) =>
      event.includes('from "reflection_record_semantic_work"'));
    expect(claimQuery).toContain('"state" =');
    expect(claimQuery).toContain('"lease_expires_at" >');
  });

  test("permits no-request fallback only for explicit recoverable waits", async () => {
    for (const failure of ["key_waiting", "recoverable_availability"] as const) {
      const setup = await fixture();
      expect(await release(setup, { failure })).toEqual([]);
    }
    const setup = await fixture();
    expect(await release(setup)).toBeNull();
  });

  test("rejects grants, execution, reconciliation, and every commit marker", async () => {
    for (const state of [
      "grant_ready",
      "claimed",
      "running",
      "publication_reconciliation",
    ] as const) {
      const waiting = requestRow("request:waiting", "awaiting_device", 1);
      const forbidden = requestRow(`request:${state}`, state, 2);
      const setup = await fixture({ requests: [waiting, forbidden] });
      expect(await release(setup)).toBeNull();
      expect(waiting["state"]).toBe("awaiting_device");
    }
    for (const marker of [
      "transform_commit_claim_id",
      "transform_commit_descriptor_hash",
      "transform_commit_recipient_generation",
      "transform_commit_output_count",
      "transform_committed_at",
    ]) {
      const waiting = requestRow("request:waiting", "awaiting_device", 1);
      waiting[marker] = marker.includes("hash")
        ? new Uint8Array(32).fill(9)
        : marker.includes("at") ? new Date(NOW) : 1;
      const setup = await fixture({ requests: [waiting] });
      expect(await release(setup)).toBeNull();
      expect(waiting["state"]).toBe("awaiting_device");
    }
  });

  test("rolls back and throws when any cancellation CAS loses", async () => {
    const setup = await fixture({
      requests: [requestRow("request:waiting", "awaiting_device", 1)],
      failCas: true,
    });
    expect(await release(setup).catch((error: unknown) => error)).toBeInstanceOf(Error);
    expect(setup.events).toContain("nautilo:rollback");
  });

  test("cancelled-only rows need explicit eligibility and never report a failure", async () => {
    const setup = await fixture({ requests: [
      requestRow("request:cancelled", "cancelled", 3),
    ] });
    expect(await release(setup)).toBeNull();
    expect(await release(setup, { failure: "key_waiting" })).toEqual([]);
  });

  test("a full page is durable progress and a later poll drains the remainder", async () => {
    const requests = Array.from(
      { length: BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH + 1 },
      (_, index) => requestRow(
        `request:${String(index).padStart(4, "0")}`,
        "awaiting_device",
        index,
      ),
    );
    const setup = await fixture({ requests });
    expect(await release(setup, { failure: "key_waiting" })).toBeNull();
    expect(setup.requests.filter((row) => row["state"] === "cancelled"))
      .toHaveLength(BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH);
    expect(setup.requests.at(-1)?.["state"]).toBe("awaiting_device");
    expect(await release(setup, { failure: "key_waiting" })).toEqual([{
      requestId: `request:${String(BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH)
        .padStart(4, "0")}`,
      recipientGeneration: BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH,
    }]);
    expect(setup.requests.every((row) => row["state"] === "cancelled")).toBe(true);
  });
});
