import { expect, test } from "bun:test";
import { MEMORY_REVIEW_MANUAL_RETRY_CODES } from "@nautilo/types";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildMemoryReviewStatusQuery, buildRetryFailedMemoryReviewsQuery,
  queryMemoryReviewStatus, retryFailedMemoryReviews,
  type MemoryReviewStatusInput,
} from "../../src/queries/memory-review-status";

const input: MemoryReviewStatusInput = {
  now: new Date("2026-09-05T12:00:00Z"), since: new Date("2026-09-04T12:00:00Z"), until: new Date("2026-09-05T12:00:00Z"),
  enabled: true, threshold: 10,
  model: { id: "synthetic:model", provider: "synthetic", source: "conductor", available: true },
  encryption: { mode: "ordinary", available: true },
};
const db = (rows: unknown) => ({ execute: async () => rows }) as unknown as Parameters<typeof queryMemoryReviewStatus>[0];

test("missing or malformed observations fail closed instead of becoming empty green status", async () => {
  expect(queryMemoryReviewStatus(db([]), input)).rejects.toThrow("no observation");
  expect(queryMemoryReviewStatus(db([{ status: { health: "healthy" } }]), input)).rejects.toThrow();
  expect(retryFailedMemoryReviews(db([{ requested: -1 }]), input.now)).rejects.toThrow();
  expect(await retryFailedMemoryReviews(db([{ requested: 0 }]), input.now)).toEqual({ requested: 0 });
});

test("status uses exact scope, source-order barrier, published outcomes, and typed metadata", () => {
  const { sql: query, params } = new PgDialect().sqlToQuery(buildMemoryReviewStatusQuery(input));
  expect(query).toContain("PARTITION BY session_id, agent_id, owner_id, access_scope");
  expect(query).toContain("first_message_id < barrier");
  expect(query).toContain("outcome = 'published'");
  expect(query).toContain("outcome = 'failed'");
  expect(query).toContain("ELSE 'unknown' END AS code");
  expect(query).not.toContain("synthetic:model");
  expect(params).toContain(JSON.stringify(input.model));
});

test("retry is atomic, excludes live scopes and protected publication failures, and counts scopes", () => {
  const { sql: query, params } = new PgDialect().sqlToQuery(buildRetryFailedMemoryReviewsQuery(input.now));
  expect(query).toContain("UPDATE memory_review_turns");
  expect(query).toContain("t.receipt_id IS NULL");
  expect(query).toContain("active.lease_until >");
  expect(query).toContain("SELECT DISTINCT session_id, agent_id, owner_id, access_scope");
  expect(params.filter(Array.isArray)).toEqual([
    [...MEMORY_REVIEW_MANUAL_RETRY_CODES], [...MEMORY_REVIEW_MANUAL_RETRY_CODES],
  ]);
});


test("operator retry permits revalidation after model repair but never replays uncertain publication", () => {
  expect(MEMORY_REVIEW_MANUAL_RETRY_CODES).toContain("iteration_exhausted");
  expect(MEMORY_REVIEW_MANUAL_RETRY_CODES).toContain("model_unavailable");
  expect(MEMORY_REVIEW_MANUAL_RETRY_CODES).toContain("authority_or_source_unavailable");
  expect(MEMORY_REVIEW_MANUAL_RETRY_CODES as readonly string[]).not.toContain("publication_uncertain");
  expect(MEMORY_REVIEW_MANUAL_RETRY_CODES as readonly string[]).not.toContain("source_or_lease_changed");
});
