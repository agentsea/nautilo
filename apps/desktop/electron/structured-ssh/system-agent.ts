import { createHash, createPublicKey, type JsonWebKey } from "node:crypto";

import { parseSshPublicIdentity, type SshPublicIdentity } from "./contracts.ts";
import { SYSTEM_OPENSSH_PATHS, type RunStructuredSshProcessInput, runStructuredSshProcess, type StructuredSshProcessResult } from "./process-runner.ts";

const SYSTEM_AGENT_ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" });
const IDENTITY_MAXIMUM = 32;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_OUTPUT_BYTES = 8 * 1024;
const NO_IDENTITIES = "The agent has no identities.";
const OPENSSH_PUBLIC_KEY_MAXIMUM_BYTES = 8 * 1024;
const ECDSA_CURVES = new Map<string, { readonly wireCurve: string; readonly jwkCurve: "P-256" | "P-384" | "P-521"; readonly coordinateBytes: number }>([
  ["ecdsa-sha2-nistp256", { wireCurve: "nistp256", jwkCurve: "P-256", coordinateBytes: 32 }],
  ["ecdsa-sha2-nistp384", { wireCurve: "nistp384", jwkCurve: "P-384", coordinateBytes: 48 }],
  ["ecdsa-sha2-nistp521", { wireCurve: "nistp521", jwkCurve: "P-521", coordinateBytes: 66 }],
]);

export type SshSystemAgentProbeReason =
  | "unsupported_platform"
  | "ssh_probe_unavailable"
  | "scp_probe_unavailable"
  | "agent_unavailable"
  | "no_identities"
  | "identity_metadata_invalid";

/** Advisory observations only; they do not establish execution readiness. */
export interface SshSystemAgentBinaryProbes {
  readonly ssh: "observed" | "unavailable";
  readonly scp: "observed" | "unavailable";
}

/**
 * Secret-free local inventory. An exact selected identity, target grant, host
 * trust, and foreground approval must be proven later before any operation is
 * considered executable. This type must not be projected as relay readiness.
 */
export interface SshSystemAgentProbe {
  readonly provider: "system-agent";
  readonly identities: readonly SshPublicIdentity[];
  readonly binaryProbes: SshSystemAgentBinaryProbes;
  readonly identityProbe: "identities_observed" | SshSystemAgentProbeReason;
  readonly executionState: "identity_selection_required" | "not_ready";
}

export interface ProbeSystemSshAgentDependencies {
  readonly platform?: NodeJS.Platform;
  readonly getEnv?: (key: "SSH_AUTH_SOCK") => string | undefined;
  readonly run?: (input: RunStructuredSshProcessInput) => Promise<StructuredSshProcessResult>;
  readonly signal?: AbortSignal;
}

/** Electron-local only. The canonical public key is never sent over relay. */
export interface ResolvedSystemAgentIdentity {
  readonly identity: SshPublicIdentity;
  readonly publicKey: string;
  /**
   * The exact agent socket used for the immediately preceding `ssh-add -L`
   * enumeration. This remains Electron-local and is never relayed or logged.
   * Optional only for compatibility with confinement-only fixtures; the broker
   * requires a valid value before it can launch OpenSSH.
   */
  readonly sshAuthSock?: string;
}

export type ResolveSystemAgentIdentityResult =
  | { readonly ok: true; readonly data: ResolvedSystemAgentIdentity }
  | { readonly ok: false; readonly reason: "agent_unavailable" | "identity_unavailable" };

function validSocket(socket: string | undefined): socket is string {
  return typeof socket === "string" && socket.length > 0 && socket.length <= 1024 && socket.startsWith("/") && !/[\0\r\n]/.test(socket);
}

function environment(socket?: string): Readonly<Record<string, string>> {
  return Object.freeze({ ...SYSTEM_AGENT_ENVIRONMENT, ...(socket === undefined ? {} : { SSH_AUTH_SOCK: socket }) });
}

function identityFromFingerprint(fingerprint: string): SshPublicIdentity {
  const digest = createHash("sha256").update("nautilo-system-agent-v1\0", "utf8").update(fingerprint, "utf8").digest("hex");
  return Object.freeze({ provider: "system-agent", publicKeyFingerprint: fingerprint, localHandle: `system-agent-${digest}` });
}

function canonicalBase64(value: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

class SshWireReader {
  private offset = 0;

  constructor(private readonly blob: Buffer) {}

  readString(maximum: number): Buffer | null {
    if (this.offset + 4 > this.blob.byteLength) return null;
    const length = this.blob.readUInt32BE(this.offset);
    this.offset += 4;
    if (length > maximum || this.offset + length > this.blob.byteLength) return null;
    const value = this.blob.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  done(): boolean {
    return this.offset === this.blob.byteLength;
  }
}

function asciiString(reader: SshWireReader, maximum: number): string | null {
  const bytes = reader.readString(maximum);
  if (bytes === null) return null;
  const value = bytes.toString("ascii");
  return Buffer.from(value, "ascii").equals(bytes) ? value : null;
}

function canonicalPositiveMpint(value: Buffer, minimum: number, maximum: number): boolean {
  if (value.byteLength < minimum || value.byteLength > maximum) return false;
  // Positive SSH mpints use a single leading zero only when the sign bit of
  // the following octet requires it. Zero and redundant sign padding are not
  // valid key parameters here.
  if (value[0] === 0) return value.byteLength > 1 && (value[1]! & 0x80) !== 0;
  return (value[0]! & 0x80) === 0;
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unsignedMpint(value: Buffer): Buffer {
  return value[0] === 0 ? value.subarray(1) : value;
}

function acceptsPublicKeyJwk(key: JsonWebKey): boolean {
  try {
    createPublicKey({ key, format: "jwk" });
    return true;
  } catch {
    return false;
  }
}

function validRsa(reader: SshWireReader): boolean {
  const exponent = reader.readString(8);
  const modulus = reader.readString(1024);
  if (exponent === null || modulus === null || !reader.done()) return false;
  if (!canonicalPositiveMpint(exponent, 1, 8) || !canonicalPositiveMpint(modulus, 128, 1024)) return false;
  // RFC 4253's ssh-rsa parameters are an odd public exponent and modulus.
  const exponentValue = BigInt(`0x${unsignedMpint(exponent).toString("hex")}`);
  if (exponentValue < 3n || (exponentValue & 1n) !== 1n || (modulus[modulus.byteLength - 1]! & 1) !== 1) return false;
  return acceptsPublicKeyJwk({ kty: "RSA", n: base64Url(unsignedMpint(modulus)), e: base64Url(unsignedMpint(exponent)) });
}

function validEcdsa(type: string, reader: SshWireReader): boolean {
  const expected = ECDSA_CURVES.get(type);
  if (expected === undefined) return false;
  const curve = asciiString(reader, 16);
  const point = reader.readString(1 + (expected.coordinateBytes * 2));
  if (curve !== expected.wireCurve || point === null || point.byteLength !== 1 + (expected.coordinateBytes * 2) || point[0] !== 0x04 || !reader.done()) return false;
  return acceptsPublicKeyJwk({
    kty: "EC",
    crv: expected.jwkCurve,
    x: base64Url(point.subarray(1, 1 + expected.coordinateBytes)),
    y: base64Url(point.subarray(1 + expected.coordinateBytes)),
  });
}

function validPublicKeyBlob(type: string, blob: Buffer): boolean {
  const reader = new SshWireReader(blob);
  if (asciiString(reader, 128) !== type) return false;
  if (type === "ssh-ed25519") {
    const key = reader.readString(32);
    return key !== null && key.byteLength === 32 && reader.done() && acceptsPublicKeyJwk({ kty: "OKP", crv: "Ed25519", x: base64Url(key) });
  }
  if (type === "ssh-rsa") return validRsa(reader);
  return validEcdsa(type, reader);
}

export function computeOpenSshSha256Fingerprint(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

interface SystemAgentPublicKey extends ResolvedSystemAgentIdentity {
  readonly fingerprint: string;
}

export interface ValidatedSystemAgentPublicKey {
  readonly canonical: string;
  readonly fingerprint: string;
}

/** Validate one comment-free OpenSSH public-key line without exposing its blob. */
export function validateSystemAgentPublicKey(publicKey: string): ValidatedSystemAgentPublicKey | null {
  if (Buffer.byteLength(publicKey, "utf8") > OPENSSH_PUBLIC_KEY_MAXIMUM_BYTES || /[\0\r\n]/.test(publicKey)) return null;
  const match = /^(ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})$/.exec(publicKey);
  const declaredType = match?.[1];
  const encodedBlob = match?.[2];
  if (declaredType === undefined || encodedBlob === undefined) return null;
  const blob = canonicalBase64(encodedBlob);
  if (blob === null || blob.byteLength === 0 || blob.byteLength > OPENSSH_PUBLIC_KEY_MAXIMUM_BYTES || !validPublicKeyBlob(declaredType, blob)) return null;
  return { canonical: `${declaredType} ${encodedBlob}`, fingerprint: computeOpenSshSha256Fingerprint(blob) };
}

/**
 * Parse `ssh-add -L` with no trust in the daemon's displayed metadata.
 * Comments are deliberately discarded; the blob is canonicalized and its wire
 * type independently checked before the fingerprint and opaque handle exist.
 */
function parseSystemAgentPublicKeys(result: StructuredSshProcessResult): readonly SystemAgentPublicKey[] | null {
  if (result.termination !== "exited") return null;
  if (result.code === 1 && result.stdout.trim() === "" && result.stderr.trim() === NO_IDENTITIES) return [];
  if (result.code !== 0 || result.stderr.trim() !== "") return null;
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > IDENTITY_MAXIMUM) return null;
  const fingerprints = new Set<string>();
  const handles = new Set<string>();
  const identities: SystemAgentPublicKey[] = [];
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > OPENSSH_PUBLIC_KEY_MAXIMUM_BYTES) return null;
    const match = /^((?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2})(?: [^\r\n]{0,4096})?$/.exec(line);
    const validated = match === null ? null : validateSystemAgentPublicKey(match[1]!);
    if (validated === null) return null;
    const fingerprint = validated.fingerprint;
    const identity = identityFromFingerprint(fingerprint);
    if (fingerprints.has(fingerprint) || handles.has(identity.localHandle)) return null;
    fingerprints.add(fingerprint);
    handles.add(identity.localHandle);
    // Reconstructing the two key fields drops every agent-supplied comment.
    identities.push({ identity, fingerprint, publicKey: validated.canonical });
  }
  return identities.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

/** Public inventory only: callers never receive the public-key bytes. */
export function parseSystemAgentIdentities(result: StructuredSshProcessResult): readonly SshPublicIdentity[] | null {
  const keys = parseSystemAgentPublicKeys(result);
  return keys === null ? null : keys.map((key) => key.identity);
}

function executableAvailable(result: StructuredSshProcessResult): boolean {
  // `scp -V` exits non-zero on some supported Apple OpenSSH builds. An exited
  // fixed-binary probe still establishes that the required local program exists.
  return result.termination === "exited";
}

/**
 * Probe the macOS system agent using only fixed Apple binaries and a finite
 * environment. Returned data is explicitly redacted public identity metadata.
 */
export async function probeSystemSshAgent(dependencies: ProbeSystemSshAgentDependencies = {}): Promise<SshSystemAgentProbe> {
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    return { provider: "system-agent", identities: [], binaryProbes: { ssh: "unavailable", scp: "unavailable" }, identityProbe: "unsupported_platform", executionState: "not_ready" };
  }
  const run = dependencies.run ?? runStructuredSshProcess;
  const invoke = (executable: RunStructuredSshProcessInput["executable"], argv: readonly string[], env: Readonly<Record<string, string>>) => run({
    executable,
    argv,
    env,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxStdoutBytes: PROBE_MAX_OUTPUT_BYTES,
    maxStderrBytes: PROBE_MAX_OUTPUT_BYTES,
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
  });
  const baseEnvironment = environment();
  const [ssh, scp] = await Promise.all([
    invoke(SYSTEM_OPENSSH_PATHS.ssh, ["-V"], baseEnvironment),
    invoke(SYSTEM_OPENSSH_PATHS.scp, ["-V"], baseEnvironment),
  ]);
  const binaryProbes: SshSystemAgentBinaryProbes = { ssh: executableAvailable(ssh) ? "observed" : "unavailable", scp: executableAvailable(scp) ? "observed" : "unavailable" };
  if (!executableAvailable(ssh)) return { provider: "system-agent", identities: [], binaryProbes, identityProbe: "ssh_probe_unavailable", executionState: "not_ready" };
  const socket = dependencies.getEnv ? dependencies.getEnv("SSH_AUTH_SOCK") : process.env["SSH_AUTH_SOCK"];
  if (!validSocket(socket)) return { provider: "system-agent", identities: [], binaryProbes, identityProbe: "agent_unavailable", executionState: "not_ready" };
  const identities = parseSystemAgentIdentities(await invoke(SYSTEM_OPENSSH_PATHS.sshAdd, ["-L"], environment(socket)));
  if (identities === null) return { provider: "system-agent", identities: [], binaryProbes, identityProbe: "identity_metadata_invalid", executionState: "not_ready" };
  if (identities.length === 0) return { provider: "system-agent", identities, binaryProbes, identityProbe: "no_identities", executionState: "not_ready" };
  return { provider: "system-agent", identities, binaryProbes, identityProbe: "identities_observed", executionState: "identity_selection_required" };
}

/**
 * Re-enumerate the current, syntactically valid agent socket immediately before
 * use. This is intentionally local: only identity metadata crosses the trust
 * boundary, while the selected public key stays in Electron for confinement.
 */
export async function resolveSystemAgentIdentity(
  selected: SshPublicIdentity,
  dependencies: ProbeSystemSshAgentDependencies = {},
): Promise<ResolveSystemAgentIdentityResult> {
  if ((dependencies.platform ?? process.platform) !== "darwin" || parseSshPublicIdentity(selected) === null) return { ok: false, reason: "identity_unavailable" };
  const socket = dependencies.getEnv ? dependencies.getEnv("SSH_AUTH_SOCK") : process.env["SSH_AUTH_SOCK"];
  if (!validSocket(socket)) return { ok: false, reason: "agent_unavailable" };
  const run = dependencies.run ?? runStructuredSshProcess;
  const result = await run({
    executable: SYSTEM_OPENSSH_PATHS.sshAdd,
    argv: ["-L"],
    env: environment(socket),
    timeoutMs: PROBE_TIMEOUT_MS,
    maxStdoutBytes: PROBE_MAX_OUTPUT_BYTES,
    maxStderrBytes: PROBE_MAX_OUTPUT_BYTES,
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
  });
  const keys = parseSystemAgentPublicKeys(result);
  if (keys === null) return { ok: false, reason: "agent_unavailable" };
  const matches = keys.filter((key) => key.identity.localHandle === selected.localHandle && key.fingerprint === selected.publicKeyFingerprint);
  return matches.length === 1
    ? { ok: true, data: { ...matches[0]!, sshAuthSock: socket } }
    : { ok: false, reason: "identity_unavailable" };
}
