import { isAbsolute, relative, resolve } from "node:path";

export interface PopulatedCloneSourceFingerprint {
  readonly instanceConfigSha256: string;
  readonly instanceEnvSha256: string;
  readonly authUserCount: number;
  readonly providerSentinelSha256: string;
  readonly productRowCount: number;
  readonly artifactCount: number;
  readonly artifactBytes: number;
  readonly artifactTreeSha256: string;
  readonly lineageEntryCount: number;
  readonly lineageSha256: string;
}

export interface ConcurrentClonePortEvidence {
  readonly workbench: number;
  readonly server: number;
  readonly nautiloDb: number;
  readonly logtoDb: number;
  readonly logtoCore: number;
  readonly logtoAdmin: number;
  readonly office: number;
  readonly collabora: number;
  readonly electronCdp: number;
}

export interface ConcurrentCloneTargetEvidence {
  readonly instanceId: string;
  readonly root: string;
  readonly projectName: string;
  readonly ports: ConcurrentClonePortEvidence;
  readonly containers: readonly [string, string, string, string];
  readonly networks: readonly [string];
  readonly volumes: readonly [string, string];
  readonly databaseIdentity: string;
  readonly logtoProjection: string;
  readonly serverPid: number;
  readonly electronPid: number;
  readonly logPath: string;
  readonly electron: {
    readonly profile: string;
    readonly connectServerUrl: string;
  };
}

export interface ConcurrentCloneIsolationEvidence {
  readonly sourceBefore: PopulatedCloneSourceFingerprint;
  readonly sourceAfter: PopulatedCloneSourceFingerprint;
  readonly targets: readonly [ConcurrentCloneTargetEvidence, ConcurrentCloneTargetEvidence];
}

export function assertPopulatedCloneSourceUnchanged(
  before: PopulatedCloneSourceFingerprint,
  after: PopulatedCloneSourceFingerprint,
): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Concurrent clone isolation failed: populated source changed");
  }
}

function assertPairwiseDisjoint(label: string, left: readonly (string | number)[], right: readonly (string | number)[]): void {
  const overlap = left.filter((value) => right.includes(value));
  if (overlap.length > 0) {
    throw new Error(`Concurrent clone isolation failed: ${label} overlap (${overlap.join(", ")})`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function portValues(target: ConcurrentCloneTargetEvidence): number[] {
  const ports = target.ports;
  return [
    ports.workbench,
    ports.server,
    ports.nautiloDb,
    ports.logtoDb,
    ports.logtoCore,
    ports.logtoAdmin,
    ports.office,
    ports.collabora,
    ports.electronCdp,
  ];
}

function validSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value) && value !== "0".repeat(64);
}

/** Safe aggregate-only assertion shared by disposable and later live acceptance. */
export function assertConcurrentCloneIsolationEvidence(
  evidence: ConcurrentCloneIsolationEvidence,
): void {
  assertPopulatedCloneSourceUnchanged(evidence.sourceBefore, evidence.sourceAfter);
  const source = evidence.sourceBefore;
  if (
    !validSha256(source.instanceConfigSha256) || !validSha256(source.instanceEnvSha256) ||
    !validSha256(source.providerSentinelSha256) || !validSha256(source.artifactTreeSha256) ||
    !validSha256(source.lineageSha256) || source.authUserCount <= 0 ||
    source.productRowCount <= 0 || source.artifactCount <= 0 || source.artifactBytes <= 0 ||
    source.lineageEntryCount <= 0
  ) throw new Error("Concurrent clone isolation failed: populated source evidence is incomplete");
  const [left, right] = evidence.targets;
  assertPairwiseDisjoint("instance identity", [left.instanceId], [right.instanceId]);
  assertPairwiseDisjoint("root", [resolve(left.root)], [resolve(right.root)]);
  if (isWithin(left.root, right.root) || isWithin(right.root, left.root)) {
    throw new Error("Concurrent clone isolation failed: target roots are nested");
  }
  assertPairwiseDisjoint("compose project", [left.projectName], [right.projectName]);
  assertPairwiseDisjoint("ports", portValues(left), portValues(right));
  assertPairwiseDisjoint("containers", left.containers, right.containers);
  assertPairwiseDisjoint("networks", left.networks, right.networks);
  assertPairwiseDisjoint("volumes", left.volumes, right.volumes);
  assertPairwiseDisjoint("database identity", [left.databaseIdentity], [right.databaseIdentity]);
  assertPairwiseDisjoint("Logto projection", [left.logtoProjection], [right.logtoProjection]);
  assertPairwiseDisjoint("server PID", [left.serverPid], [right.serverPid]);
  assertPairwiseDisjoint("Electron PID", [left.electronPid], [right.electronPid]);
  assertPairwiseDisjoint("log path", [resolve(left.logPath)], [resolve(right.logPath)]);
  assertPairwiseDisjoint("Electron profile", [left.electron.profile], [right.electron.profile]);
  assertPairwiseDisjoint("Electron connection", [left.electron.connectServerUrl], [right.electron.connectServerUrl]);

  for (const target of evidence.targets) {
    const ports = portValues(target);
    if (
      !isAbsolute(target.root) || ports.length !== 9 ||
      ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535) ||
      new Set(ports).size !== 9 ||
      new Set(target.containers).size !== 4 || new Set(target.volumes).size !== 2 ||
      !Number.isInteger(target.serverPid) || !Number.isInteger(target.electronPid) ||
      target.serverPid <= 0 || target.electronPid <= 0 || target.electron.profile.trim() === "" ||
      target.instanceId.trim() === "" || target.projectName.trim() === "" ||
      target.containers.some((value) => value.trim() === "") || target.networks[0].trim() === "" ||
      target.volumes.some((value) => value.trim() === "")
    ) {
      throw new Error("Concurrent clone isolation failed: target topology/runtime evidence is incomplete");
    }
    let connection: URL;
    try {
      connection = new URL(target.electron.connectServerUrl);
    } catch {
      throw new Error("Concurrent clone isolation failed: Electron connection is invalid");
    }
    const connectionPort = Number(connection.port || (connection.protocol === "https:" ? 443 : 80));
    if (
      !["http:", "https:"].includes(connection.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(connection.hostname)
    ) throw new Error("Concurrent clone isolation failed: Electron connection is not loopback HTTP(S)");
    if (connectionPort !== target.ports.server) {
      throw new Error("Concurrent clone isolation failed: Electron connection does not target its server port");
    }
    if (target.instanceId === "" || target.databaseIdentity !== target.instanceId) {
      throw new Error("Concurrent clone isolation failed: target database identity was not rebound");
    }
    if (target.logtoProjection !== target.instanceId) {
      throw new Error("Concurrent clone isolation failed: target Logto projection was not rebound");
    }
    if (!isWithin(target.root, target.logPath)) {
      throw new Error("Concurrent clone isolation failed: target log escaped its root");
    }
  }
}
