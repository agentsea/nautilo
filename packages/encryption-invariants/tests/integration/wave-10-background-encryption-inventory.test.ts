import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  BACKGROUND_ENCRYPTION_SURFACES,
  validateBackgroundEncryptionInventory,
} from "../../src/node/background-encryption-inventory";

const repositoryRoot = resolve(import.meta.dir, "../../../..");

describe("Wave 10 background encryption inventory", () => {
  test("pins every protected background plaintext and invocation boundary", () => {
    expect(BACKGROUND_ENCRYPTION_SURFACES.map((surface) => surface.id))
      .toEqual([
        "stenographer.server",
        "stenographer.worker",
        "stenographer.source.live",
        "stenographer.source.historical",
        "stenographer.source.rebuild",
        "stenographer.source.prior",
        "stenographer.source.journal",
        "stenographer.model.extraction",
        "stenographer.model.compaction",
        "stenographer.compaction.claim",
        "stenographer.publish.events",
        "stenographer.publish.compaction",
        "stenographer.rebuild",
        "stenographer.admin_status",
        "reflection.worker",
        "reflection.model",
        "reflection.publish",
        "foreground.journal.read",
        "foreground.journal.main",
        "foreground.journal.fork",
        "memory.caller.main",
        "memory.caller.fork",
        "memory.review",
        "memory.search",
        "memory.manage",
        "memory.exit_flush",
        "task.server",
        "task.observer",
        "task.dispatch",
        "task.job",
        "task.job_persistence",
        "task.execute",
        "task.lifecycle",
        "task.approval_resume",
        "task.await_reply",
        "job.manager",
        "job.route",
      ]);
  });

  test("classifies the Stenographer vertical separately from dark adapters", () => {
    expect(
      BACKGROUND_ENCRYPTION_SURFACES
        .filter((surface) => surface.ownership === "wave10_vertical")
        .map((surface) => surface.id),
    ).toEqual([
      "stenographer.server",
      "stenographer.worker",
      "stenographer.source.live",
      "stenographer.source.historical",
      "stenographer.source.rebuild",
      "stenographer.source.prior",
      "stenographer.source.journal",
      "stenographer.model.extraction",
      "stenographer.model.compaction",
      "stenographer.compaction.claim",
      "stenographer.publish.events",
      "stenographer.publish.compaction",
      "stenographer.rebuild",
      "stenographer.admin_status",
      "reflection.worker",
      "reflection.model",
      "reflection.publish",
      "foreground.journal.read",
      "foreground.journal.main",
      "foreground.journal.fork",
    ]);
    expect(
      BACKGROUND_ENCRYPTION_SURFACES
        .filter((surface) => surface.ownership === "wave10_dark_adapter")
        .map((surface) => surface.id),
    ).toEqual([
      "memory.caller.main",
      "memory.caller.fork",
      "memory.review",
      "memory.search",
      "memory.manage",
      "memory.exit_flush",
      "task.server",
      "task.observer",
      "task.dispatch",
      "task.job",
      "task.job_persistence",
      "task.execute",
      "task.lifecycle",
      "task.approval_resume",
      "task.await_reply",
      "job.manager",
      "job.route",
    ]);
  });

  test("keeps all source anchors executable and fails closed on drift", () => {
    expect(validateBackgroundEncryptionInventory(repositoryRoot)).toEqual([]);
    expect(validateBackgroundEncryptionInventory(repositoryRoot, [{
      id: "stenographer.source.live",
      sourcePath: "packages/runtime/src/stenographer/repository.ts",
      anchor: "missing Wave 10 source loader",
      ownership: "wave10_vertical",
      duties: ["metadata_discovery", "plaintext_read", "protected_read"],
    }])).toEqual([
      "missing background encryption anchor: packages/runtime/src/stenographer/repository.ts#missing Wave 10 source loader",
    ]);
  });
});
