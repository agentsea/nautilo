import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createReadyToWorkDesiredState,
  parseReadyToWorkDesiredState,
  readyToWorkAggregateStatus,
  withReadyToWorkCodingHarnesses,
  type ReadyToWorkBinding,
} from "../../electron/ready-to-work-contract";
import {
  ReadyToWorkStore,
  writeReadyToWorkDesiredStateAtomically,
  type ReadyToWorkStoreFs,
} from "../../electron/ready-to-work-store";

let tempRoot = "";

const binding: ReadyToWorkBinding = {
  humanId: "human-17",
  authority: {
    scope: "https://alpha.example.test",
    revision: "revision-17",
    connectionAttemptId: "attempt-17",
    serverFingerprint: "fingerprint-17",
  },
};

const selection = {
  voice: true,
  auto_approve: true,
  workstation: true,
  computer_use: false,
  coding_connection: true,
} as const;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nautilo-ready-to-work-"));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function storePath(): string {
  return path.join(tempRoot, "ready-to-work.json");
}

describe("Ready-to-work desired state", () => {
  test("defaults to Standard and projects intent without claiming authority", () => {
    const store = new ReadyToWorkStore({ filePath: storePath() });
    expect(readyToWorkAggregateStatus(store.loadFor(binding))).toEqual({
      mode: "standard",
      components: [
        { id: "voice", state: "off_by_choice", reason: "not_selected", repairTarget: null },
        { id: "auto_approve", state: "off_by_choice", reason: "not_selected", repairTarget: null },
        { id: "workstation", state: "off_by_choice", reason: "not_selected", repairTarget: null },
        { id: "computer_use", state: "off_by_choice", reason: "not_selected", repairTarget: null },
        { id: "coding_connection", state: "off_by_choice", reason: "not_selected", repairTarget: null },
      ],
    });

    const desired = createReadyToWorkDesiredState(binding, selection);
    store.save(desired);
    const status = readyToWorkAggregateStatus(store.loadFor(binding));
    expect(status.mode).toBe("ready");
    expect(status.components).toEqual([
      { id: "voice", state: "needs_attention", reason: "restore_requested", repairTarget: "voice_settings" },
      { id: "auto_approve", state: "needs_attention", reason: "restore_requested", repairTarget: "auto_approve_settings" },
      { id: "workstation", state: "needs_attention", reason: "restore_requested", repairTarget: "workstation_settings" },
      { id: "computer_use", state: "off_by_choice", reason: "not_selected", repairTarget: null },
      { id: "coding_connection", state: "needs_attention", reason: "restore_requested", repairTarget: "coding_connection_settings" },
    ]);
    expect(JSON.stringify(status)).not.toContain(binding.humanId);
    expect(JSON.stringify(status)).not.toContain(binding.authority.serverFingerprint);
  });

  test("projects enabled harness owners separately without changing durable selection", () => {
    const desired = createReadyToWorkDesiredState(binding, selection);
    const status = withReadyToWorkCodingHarnesses(readyToWorkAggregateStatus(desired, {
      coding_connection: { state: "ready", reason: null, repairTarget: "coding_connection_settings" },
    }), [
      { id: "codex", state: "ready", reason: null, repairTarget: "coding_connection_settings" },
      { id: "hermes-acp", state: "needs_attention", reason: "coding_harness_unavailable", repairTarget: "coding_connection_settings" },
    ]);
    expect(status.codingHarnesses).toEqual([
      { id: "codex", state: "ready", reason: null, repairTarget: "coding_connection_settings" },
      { id: "hermes-acp", state: "needs_attention", reason: "coding_harness_unavailable", repairTarget: "coding_connection_settings" },
    ]);
    expect(desired.components).toEqual(selection);
  });

  test("projects enabled harness owners for the Standard enrollment preview", () => {
    const status = withReadyToWorkCodingHarnesses(readyToWorkAggregateStatus(null), [
      { id: "codex", state: "ready", reason: null, repairTarget: "coding_connection_settings" },
      { id: "hermes-acp", state: "needs_attention", reason: "coding_harness_unavailable", repairTarget: "coding_connection_settings" },
    ]);
    expect(status.mode).toBe("standard");
    expect(status.codingHarnesses?.map((harness) => harness.id)).toEqual(["codex", "hermes-acp"]);
  });

  test("rejects malformed or partial records and never treats them as Ready", () => {
    expect(parseReadyToWorkDesiredState({
      version: 1,
      humanId: binding.humanId,
      authority: binding.authority,
      components: { voice: true },
    })).toBeNull();
    expect(parseReadyToWorkDesiredState({
      version: 1,
      humanId: binding.humanId,
      authority: { ...binding.authority, token: "must-not-parse" },
      components: selection,
    })).toBeNull();
    fs.writeFileSync(storePath(), "{half-written", "utf-8");
    const store = new ReadyToWorkStore({ filePath: storePath() });
    expect(store.loadFor(binding)).toBeNull();
    expect(readyToWorkAggregateStatus(store.loadFor(binding)).mode).toBe("standard");
    expect(store.clear()).toBeTrue();
    expect(fs.existsSync(storePath())).toBeFalse();
  });

  test("scopes desired intent to the exact Human and complete active authority", () => {
    const store = new ReadyToWorkStore({ filePath: storePath() });
    store.save(createReadyToWorkDesiredState(binding, selection));
    expect(store.loadFor({ ...binding, humanId: "human-18" })).toBeNull();
    expect(store.loadFor({
      ...binding,
      authority: { ...binding.authority, revision: "revision-18" },
    })).toBeNull();
    expect(store.loadFor({
      ...binding,
      authority: { ...binding.authority, serverFingerprint: "fingerprint-18" },
    })).toBeNull();
    expect(store.clearFor({ ...binding, humanId: "human-18" })).toBeFalse();
    expect(store.loadFor(binding)).not.toBeNull();
  });

  test("restores a source-development binding across its process-local marker rotation", () => {
    const sourceBinding: ReadyToWorkBinding = {
      ...binding,
      authority: {
        ...binding.authority,
        revision: "dev-process-one",
        connectionAttemptId: "legacy-dev-process-one",
      },
    };
    const store = new ReadyToWorkStore({ filePath: storePath() });
    store.save(createReadyToWorkDesiredState(sourceBinding, selection));

    expect(store.loadFor({
      ...sourceBinding,
      authority: {
        ...sourceBinding.authority,
        revision: "dev-process-two",
        connectionAttemptId: "legacy-dev-process-two",
      },
    })).not.toBeNull();
    expect(store.loadFor({
      ...sourceBinding,
      authority: { ...sourceBinding.authority, serverFingerprint: "fingerprint-18" },
    })).toBeNull();
    expect(store.loadFor({
      ...sourceBinding,
      authority: { ...sourceBinding.authority, scope: "https://other.nautilo.dev" },
    })).toBeNull();
    expect(store.loadFor({
      ...sourceBinding,
      authority: {
        ...sourceBinding.authority,
        revision: "revision-18",
        connectionAttemptId: "attempt-18",
      },
    })).toBeNull();
  });

  test("keeps a canonical active fingerprint opaque without narrowing its format", () => {
    expect(parseReadyToWorkDesiredState({
      version: 1,
      humanId: binding.humanId,
      authority: {
        ...binding.authority,
        serverFingerprint: "desktop-app|https://api.nautilo.dev",
      },
      components: selection,
    })).not.toBeNull();
  });

  test("a failed atomic replacement leaves the prior complete state intact", () => {
    const first = createReadyToWorkDesiredState(binding, selection);
    fs.writeFileSync(storePath(), JSON.stringify(first), "utf-8");
    const failingFs: ReadyToWorkStoreFs = {
      mkdirSync: fs.mkdirSync,
      openSync: fs.openSync,
      writeFileSync: fs.writeFileSync,
      closeSync: fs.closeSync,
      renameSync: () => { throw new Error("rename failed"); },
      unlinkSync: fs.unlinkSync,
      readFileSync: fs.readFileSync,
    };
    expect(() => writeReadyToWorkDesiredStateAtomically({
      filePath: storePath(),
      desired: createReadyToWorkDesiredState(binding, {
        ...selection,
        computer_use: true,
      }),
      temporaryId: "replacement",
      fs: failingFs,
    })).toThrow("rename failed");
    expect(new ReadyToWorkStore({ filePath: storePath() }).loadFor(binding)).toEqual(first);
    expect(fs.existsSync(`${storePath()}.replacement.tmp`)).toBeFalse();
  });
});
