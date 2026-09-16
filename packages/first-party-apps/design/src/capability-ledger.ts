import type { DesignTransactionRequest } from "./transactions";
import type { OrganizationTransaction } from "./organization";

type Actor = "human" | "agent";
type KernelRequestKind = DesignTransactionRequest["kind"] | OrganizationTransaction["kind"];

type KernelCoverage = {
  actor: Actor;
  entryPoint: string;
  kernelRequestKinds: readonly KernelRequestKind[];
  disposition?: never;
};

type ReviewedDisposition = {
  actor: Actor;
  entryPoint: string;
  kernelRequestKinds?: never;
  disposition: string;
};

export type DurableMutationCapability = KernelCoverage | ReviewedDisposition;

/**
 * A code-enforced companion to CAPABILITY_AND_RACE_MATRIX.md. It intentionally
 * records capability coverage, not false one-to-one actor symmetry: adapters
 * can lower one affordance into several canonical requests, while unsupported
 * document mutations must carry an explicit reviewed disposition.
 */
export const DURABLE_MUTATION_CAPABILITIES = [
  { actor: "human", entryPoint: "DesignStore.addNode", kernelRequestKinds: ["create"] },
  { actor: "human", entryPoint: "DesignStore.updateNode", kernelRequestKinds: ["transform", "rotate", "rename", "style", "text"] },
  { actor: "human", entryPoint: "DesignStore.updateNodes", kernelRequestKinds: ["transform", "rotate", "rename", "style", "text"] },
  { actor: "human", entryPoint: "DesignStore.updateNodePatches", kernelRequestKinds: ["transform", "rotate", "rename", "style", "text"] },
  { actor: "human", entryPoint: "DesignStore.transact", kernelRequestKinds: ["create", "image", "transform", "affine", "rotate", "rename", "style", "text", "align", "distribute", "delete", "connector", "page", "reorder", "boolean", "vector", "revert"] },
  { actor: "human", entryPoint: "DesignStore.organize", kernelRequestKinds: ["group", "ungroup", "reparent", "duplicate", "insert", "flags", "page-edit", "page-order"] },
  { actor: "human", entryPoint: "DesignStore.deleteNodes", kernelRequestKinds: ["delete"] },
  { actor: "human", entryPoint: "DesignStore.nudgeNodes", kernelRequestKinds: ["transform"] },
  { actor: "human", entryPoint: "DesignStore.updateTransientNodes", kernelRequestKinds: ["transform"] },
  { actor: "human", entryPoint: "DesignStore.transformTransient", kernelRequestKinds: ["affine"] },
  { actor: "human", entryPoint: "DesignStore.addVectorNode", kernelRequestKinds: ["create"] },
  { actor: "human", entryPoint: "ellipse/line/polygon tools", kernelRequestKinds: ["create"] },
  { actor: "human", entryPoint: "Inspector rotation", kernelRequestKinds: ["rotate"] },
  { actor: "human", entryPoint: "DesignStore.updateTransientVector", kernelRequestKinds: ["vector"] },
  { actor: "human", entryPoint: "DesignStore.groupAsBoolean", kernelRequestKinds: ["boolean"] },
  { actor: "human", entryPoint: "DesignStore.reorderPageChild", kernelRequestKinds: ["reorder"] },
  { actor: "human", entryPoint: "DesignStore.addPage", kernelRequestKinds: ["page"] },
  { actor: "human", entryPoint: "DesignStore.addConnector", kernelRequestKinds: ["create"] },
  { actor: "human", entryPoint: "DesignStore.updateConnector", kernelRequestKinds: ["connector"] },
  { actor: "human", entryPoint: "DesignStore.applyEphemeralRevert", kernelRequestKinds: ["revert"] },
  { actor: "human", entryPoint: "new-design create action", disposition: "Host-owned initial-document construction; it does not mutate an existing parsed scene." },
  { actor: "human", entryPoint: "align/distribute controls", kernelRequestKinds: ["align", "distribute"] },
  { actor: "human", entryPoint: "DesignStore.undo", disposition: "Local snapshot undo, not a cross-actor transaction history or agent receipt." },
  { actor: "human", entryPoint: "DesignStore.redo", disposition: "Local snapshot redo, not a cross-actor transaction history or agent receipt." },
  { actor: "human", entryPoint: "DesignStore.copySelection", disposition: "Local clipboard fragment construction only; it does not mutate the parsed scene. Paste is organized through the canonical insert request." },
  { actor: "human", entryPoint: "selection state", disposition: "Local active-page and selection presentation state; it is not serialized or agent-addressable durable scene state." },
  { actor: "human", entryPoint: "pointer and keyboard gestures", disposition: "Local preview, hit-testing, snapping, marquee, and pan state. Gesture document changes use transformTransient/commitTransient or other listed store transactions." },
  { actor: "agent", entryPoint: "create-frame", kernelRequestKinds: ["create"] },
  { actor: "agent", entryPoint: "create-text", kernelRequestKinds: ["create"] },
  { actor: "agent", entryPoint: "create-shape", kernelRequestKinds: ["create"] },
  { actor: "agent", entryPoint: "set-node-props", kernelRequestKinds: ["transform", "rotate", "rename", "style", "text"] },
  { actor: "agent", entryPoint: "replace-text", kernelRequestKinds: ["text"] },
  { actor: "agent", entryPoint: "layout-nodes", kernelRequestKinds: ["align", "distribute"] },
  { actor: "agent", entryPoint: "set-node-props.src", disposition: "Raw sources remain rejected; use a host-inspected assetRef through the create or image semantic operation." },
  { actor: "agent", entryPoint: "arrange-nodes", kernelRequestKinds: ["reorder"] },
  { actor: "agent", entryPoint: "create-file", disposition: "Host create action owns initial-document construction; it does not mutate an existing parsed scene." },
  { actor: "agent", entryPoint: "ordinary group/ungroup/reparent/duplicate/flags/page edit", disposition: "Pending limitation: these D575 structural operations are human-only organizer requests. No declared agent tool or edit-open-design operation maps to them yet, so this ledger does not claim actor symmetry." },
  {
    actor: "agent",
    entryPoint: "edit-open-design",
    kernelRequestKinds: [
      "create",
      "image",      "transform",
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
  },
  {
    actor: "agent",
    entryPoint: "edit-open-design stale recovery",
    disposition: "Each approved edit carries exact inspection-derived semanticVersion preconditions for every referenced existing public node/page handle; batch-local refs are exempt. On a stale canonical version, the trusted host compares those frozen preconditions before any transaction or write. Semantically unchanged disjoint/create intent is applied automatically as the same approved batch with no second model call or approval. Any referenced-resource drift returns a bounded handles-only semantic_conflict with stateChanged false, retrySafe false, and recovery ask_user/refresh_intent; the worker is not invoked and no generic overwrite approval is possible. Idempotency includes preconditions and replays only an exact lost response.",
  },
  {
    actor: "agent",
    entryPoint: "edit-open-design receipt Revert",
    disposition: "A successful attributed non-structural live write is projected into the existing human receipt card; its trusted before/after snapshots feed DesignStore.applyEphemeralRevert. Moxie never receives raw restore snapshots or Revert authority.",
  },
] as const satisfies readonly DurableMutationCapability[];

/** This reviewed fixed list is deliberately not automatic source discovery. */
export const AUDITED_DURABLE_MUTATION_ENTRY_POINTS = [
  "human:DesignStore.addNode",
  "human:DesignStore.updateNode",
  "human:DesignStore.updateNodes",
  "human:DesignStore.updateNodePatches",
  "human:DesignStore.transact",
  "human:DesignStore.organize",
  "human:DesignStore.deleteNodes",
  "human:DesignStore.nudgeNodes",
  "human:DesignStore.updateTransientNodes",
  "human:DesignStore.transformTransient",
  "human:DesignStore.addVectorNode",
  "human:ellipse/line/polygon tools",
  "human:Inspector rotation",
  "human:DesignStore.updateTransientVector",
  "human:DesignStore.groupAsBoolean",
  "human:DesignStore.reorderPageChild",
  "human:DesignStore.addPage",
  "human:DesignStore.addConnector",
  "human:DesignStore.updateConnector",
  "human:DesignStore.applyEphemeralRevert",
  "human:new-design create action",
  "human:align/distribute controls",
  "human:DesignStore.undo",
  "human:DesignStore.redo",
  "human:DesignStore.copySelection",
  "human:selection state",
  "human:pointer and keyboard gestures",
  "agent:create-frame",
  "agent:create-text",
  "agent:create-shape",
  "agent:set-node-props",
  "agent:replace-text",
  "agent:layout-nodes",
  "agent:set-node-props.src",
  "agent:arrange-nodes",
  "agent:create-file",
  "agent:ordinary group/ungroup/reparent/duplicate/flags/page edit",
  "agent:edit-open-design",
  "agent:edit-open-design stale recovery",
  "agent:edit-open-design receipt Revert",
] as const;

export function assertCapabilityLedgerCoverage(
  entries: readonly DurableMutationCapability[] = DURABLE_MUTATION_CAPABILITIES,
): void {
  const expected: Set<string> = new Set(AUDITED_DURABLE_MUTATION_ENTRY_POINTS);
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.actor}:${entry.entryPoint}`;
    if (!expected.has(key)) throw new Error(`Unaudited durable mutation entry point: ${key}`);
    if (seen.has(key)) throw new Error(`Duplicate durable mutation entry point: ${key}`);
    seen.add(key);
    if ("kernelRequestKinds" in entry) {
      if (entry.kernelRequestKinds.length === 0) throw new Error(`Missing kernel mapping: ${key}`);
    } else if (entry.disposition.trim().length === 0) {
      throw new Error(`Missing reviewed disposition: ${key}`);
    }
  }
  for (const key of expected) {
    if (!seen.has(key)) throw new Error(`Missing durable mutation ledger entry: ${key}`);
  }
}
