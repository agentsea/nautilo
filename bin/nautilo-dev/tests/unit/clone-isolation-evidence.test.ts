import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertConcurrentCloneIsolationEvidence,
  type ConcurrentCloneTargetEvidence,
  type PopulatedCloneSourceFingerprint,
} from "../../src/lib/clone-isolation-evidence";

export const populatedSource: PopulatedCloneSourceFingerprint = {
  instanceConfigSha256: "a".repeat(64),
  instanceEnvSha256: "b".repeat(64),
  authUserCount: 2,
  providerSentinelSha256: "c".repeat(64),
  productRowCount: 37,
  artifactCount: 3,
  artifactBytes: 4_096,
  artifactTreeSha256: "d".repeat(64),
  lineageEntryCount: 12,
  lineageSha256: "e".repeat(64),
};

export function isolatedTarget(id: string, stride: number): ConcurrentCloneTargetEvidence {
  const root = `/private/tmp/d489/.nautilo-${id}`;
  const project = `nautilo-${id}`;
  return {
    instanceId: id,
    root,
    projectName: project,
    ports: {
      workbench: 3_000 + stride,
      server: 3_001 + stride,
      nautiloDb: 5_432 + stride,
      logtoDb: 5_433 + stride,
      logtoCore: 3_301 + stride,
      logtoAdmin: 3_302 + stride,
      office: 2_003 + stride,
      collabora: 9_980 + stride,
      electronCdp: 9_222 + stride,
    },
    containers: [`${project}-postgres`, `${project}-postgres-1`, `${project}-logto-1`, `${project}-logto-seed-1`],
    networks: [`${project}_default`],
    volumes: [`${project}_nautilo_pgdata`, `${project}_pgdata`],
    databaseIdentity: id,
    logtoProjection: id,
    serverPid: 10_000 + stride,
    electronPid: 20_000 + stride,
    logPath: join(root, "logs", "dev-stack.log"),
    electron: { profile: `d489-${id}`, connectServerUrl: `http://localhost:${3_001 + stride}` },
  };
}

describe("D489 concurrent clone isolation evidence", () => {
  test("accepts two complete disjoint target tuples and an unchanged populated source", () => {
    expect(() => assertConcurrentCloneIsolationEvidence({
      sourceBefore: populatedSource,
      sourceAfter: { ...populatedSource },
      targets: [isolatedTarget("alpha", 100), isolatedTarget("beta", 200)],
    })).not.toThrow();
  });

  test("fails closed for topology, identity, runtime, Electron, and source boundaries", () => {
    const left = isolatedTarget("alpha", 100);
    const right = isolatedTarget("beta", 200);
    const corruptions: Array<{ label: string; right: ConcurrentCloneTargetEvidence }> = [
      { label: "ports", right: { ...right, ports: { ...right.ports, electronCdp: left.ports.electronCdp } } },
      { label: "containers", right: { ...right, containers: left.containers } },
      { label: "networks", right: { ...right, networks: left.networks } },
      { label: "volumes", right: { ...right, volumes: left.volumes } },
      { label: "database identity", right: { ...right, databaseIdentity: left.databaseIdentity } },
      { label: "Logto projection", right: { ...right, logtoProjection: left.logtoProjection } },
      { label: "server PID", right: { ...right, serverPid: left.serverPid } },
      { label: "Electron PID", right: { ...right, electronPid: left.electronPid } },
      { label: "log path", right: { ...right, logPath: left.logPath } },
      { label: "Electron profile", right: { ...right, electron: { ...right.electron, profile: left.electron.profile } } },
      { label: "Electron connection", right: { ...right, electron: { ...right.electron, connectServerUrl: left.electron.connectServerUrl } } },
    ];
    for (const corruption of corruptions) {
      expect(() => assertConcurrentCloneIsolationEvidence({
        sourceBefore: populatedSource,
        sourceAfter: populatedSource,
        targets: [left, corruption.right],
      })).toThrow(corruption.label);
    }
    expect(() => assertConcurrentCloneIsolationEvidence({
      sourceBefore: populatedSource,
      sourceAfter: { ...populatedSource, productRowCount: 38 },
      targets: [left, right],
    })).toThrow("populated source changed");
    expect(() => assertConcurrentCloneIsolationEvidence({
      sourceBefore: populatedSource,
      sourceAfter: populatedSource,
      targets: [left, { ...right, logPath: "/tmp/escaped.log" }],
    })).toThrow("log escaped");
    expect(() => assertConcurrentCloneIsolationEvidence({
      sourceBefore: populatedSource,
      sourceAfter: populatedSource,
      targets: [left, { ...right, electron: { ...right.electron, connectServerUrl: "http://localhost:65500" } }],
    })).toThrow("server port");
    expect(() => assertConcurrentCloneIsolationEvidence({
      sourceBefore: { ...populatedSource, authUserCount: 0 },
      sourceAfter: { ...populatedSource, authUserCount: 0 },
      targets: [left, right],
    })).toThrow("source evidence is incomplete");
    expect(() => assertConcurrentCloneIsolationEvidence({
      sourceBefore: populatedSource,
      sourceAfter: populatedSource,
      targets: [left, { ...right, networks: [""] }],
    })).toThrow("topology/runtime evidence is incomplete");
    expect(() => assertConcurrentCloneIsolationEvidence({
      sourceBefore: populatedSource,
      sourceAfter: populatedSource,
      targets: [left, {
        ...right,
        electron: { ...right.electron, connectServerUrl: `ftp://example.com:${right.ports.server}` },
      }],
    })).toThrow("loopback HTTP");
  });
});
