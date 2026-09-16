import { expect, test } from "bun:test";
import {
  assertCapabilityLedgerCoverage,
  DURABLE_MUTATION_CAPABILITIES,
} from "./capability-ledger";

test("the durable mutation ledger covers every audited entry point", () => {
  expect(() => assertCapabilityLedgerCoverage()).not.toThrow();
  expect(DURABLE_MUTATION_CAPABILITIES).toContainEqual({
    actor: "agent",
    entryPoint: "set-node-props.src",
    disposition: "Raw sources remain rejected; use a host-inspected assetRef through the create or image semantic operation.",
  });
  expect(DURABLE_MUTATION_CAPABILITIES).toContainEqual({
    actor: "human",
    entryPoint: "Inspector rotation",
    kernelRequestKinds: ["rotate"],
  });
  expect(DURABLE_MUTATION_CAPABILITIES).toContainEqual({
    actor: "human",
    entryPoint: "ellipse/line/polygon tools",
    kernelRequestKinds: ["create"],
  });
  expect(DURABLE_MUTATION_CAPABILITIES).toContainEqual({
    actor: "human",
    entryPoint: "align/distribute controls",
    kernelRequestKinds: ["align", "distribute"],
  });
  expect(DURABLE_MUTATION_CAPABILITIES).toContainEqual({
    actor: "agent",
    entryPoint: "arrange-nodes",
    kernelRequestKinds: ["reorder"],
  });
  const liveEdit = DURABLE_MUTATION_CAPABILITIES.find(
    (entry) => entry.actor === "agent" && entry.entryPoint === "edit-open-design",
  );
  expect(liveEdit).toEqual({
    actor: "agent",
    entryPoint: "edit-open-design",
    kernelRequestKinds: [
      "create",
      "image",
      "transform",
      "rotate",
      "rename",
      "style",
      "text",
      "align",
      "distribute",
      "delete",
      "connector",
      "page",
      "reorder",
      "boolean",
      "vector",
    ],
  });
  expect(DURABLE_MUTATION_CAPABILITIES).toContainEqual({
    actor: "human",
    entryPoint: "DesignStore.applyEphemeralRevert",
    kernelRequestKinds: ["revert"],
  });
  expect(DURABLE_MUTATION_CAPABILITIES).toContainEqual({
    actor: "human",
    entryPoint: "DesignStore.organize",
    kernelRequestKinds: ["group", "ungroup", "reparent", "duplicate", "insert", "flags", "page-edit", "page-order"],
  });
  expect(DURABLE_MUTATION_CAPABILITIES).toContainEqual({
    actor: "human",
    entryPoint: "DesignStore.transformTransient",
    kernelRequestKinds: ["affine"],
  });
  const pendingStructuralOps = DURABLE_MUTATION_CAPABILITIES.find(
    (entry) => entry.actor === "agent" && entry.entryPoint === "ordinary group/ungroup/reparent/duplicate/flags/page edit",
  );
  expect(pendingStructuralOps && "disposition" in pendingStructuralOps).toBe(true);
  if (pendingStructuralOps && "disposition" in pendingStructuralOps) {
    expect(pendingStructuralOps.disposition).toContain("Pending limitation");
    expect(pendingStructuralOps.disposition).toContain("does not claim actor symmetry");
  }
  const staleRecovery = DURABLE_MUTATION_CAPABILITIES.find(
    (entry) =>
      entry.actor === "agent" &&
      entry.entryPoint === "edit-open-design stale recovery",
  );
  expect(staleRecovery && "disposition" in staleRecovery).toBe(true);
  if (staleRecovery && "disposition" in staleRecovery) {
    expect(staleRecovery.disposition).toContain("inspection-derived semanticVersion preconditions");
    expect(staleRecovery.disposition).toContain("frozen preconditions");
    expect(staleRecovery.disposition).toContain("applied automatically");
    expect(staleRecovery.disposition).toContain("no second model call or approval");
    expect(staleRecovery.disposition).toContain("semantic_conflict");
    expect(staleRecovery.disposition).toContain("stateChanged false");
    expect(staleRecovery.disposition).toContain("retrySafe false");
    expect(staleRecovery.disposition).toContain("ask_user/refresh_intent");
    expect(staleRecovery.disposition).toContain("worker is not invoked");
    expect(staleRecovery.disposition).toContain("exact lost response");
    expect(staleRecovery.disposition).not.toContain("reinspect");
  }
  const liveRevert = DURABLE_MUTATION_CAPABILITIES.find(
    (entry) =>
      entry.actor === "agent" &&
      entry.entryPoint === "edit-open-design receipt Revert",
  );
  expect(liveRevert && "disposition" in liveRevert).toBe(true);
  if (liveRevert && "disposition" in liveRevert) {
    expect(liveRevert.disposition).toContain(
      "Moxie never receives raw restore snapshots",
    );
  }
});
