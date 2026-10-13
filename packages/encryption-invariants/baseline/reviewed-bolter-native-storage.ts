import type { EncryptionCoverageEntry } from "../src/model";
import type { SourceDeclaration } from "../src/node/source-inventory";
import type { SourceAlarmReview } from "../src/node/source-alarm-review";
const HANDOVER = "apps/desktop/electron/bolter-bridge/handover.ts";
const MANAGED = "apps/desktop/electron/bolter-bridge/managed-connection.ts";
const RUNTIME = "apps/desktop/electron/bolter-bridge/runtime.ts";
const HELPER = "apps/desktop/electron/bolter-bridge/helper-runtime.ts";
const BUILD = "apps/desktop/scripts/build-bolter-handover.ts";
const FINALIZER = "packages/db/scripts/finalize-bolter-reviewed-share.ts";
const TEST = "packages/encryption-invariants/tests/integration/bolter-native-storage.test.ts";

export const BOLTER_NATIVE_STORAGE_DECLARATIONS: readonly SourceDeclaration[] = [{
  id: "source.file.bolter-connection-descriptor", surface: "file", locator: `${MANAGED}#sealed-recovery-descriptor`, role: "store",
  evidence: [{ path: MANAGED, symbols: ["config.cipher.seal(JSON.stringify(descriptor))", "file.writeFile(ciphertext)", "file.sync()", "await directory.sync()", "createHash(\"sha256\").update(JSON.stringify(scope))", "config.cipher.isAvailable()"] }],
}];
export const BOLTER_NATIVE_STORAGE_COVERAGE: readonly EncryptionCoverageEntry[] = [{
  id: "file.bolter-connection-descriptor", surface: "file", locator: `${MANAGED}#sealed-recovery-descriptor`, owner: "apps/desktop",
  readers: [MANAGED], writers: [MANAGED], classification: "device_local", migrationState: "not_applicable",
  deviceStorage: "Server, Human and connection scoped recovery coordinates are sealed through the Electron safeStorage cipher before exclusive mode-0600 temporary write, atomic rename and directory sync beneath an owned private parent. Descriptor identity and opaque HOME handle are not provider credentials or message bodies. This is device storage, not Namespace encryption.",
  retention: "The encrypted descriptor survives Desktop restart to recover the same local identity. Revocation does not promise erasure of this file or provider credentials held by the isolated CLI HOME.",
  cleanupContract: "Temporary descriptor files are removed after settlement. The committed descriptor remains device-local; unrelated Human or connection coordinates cannot select it. Production uses the OS-protection cipher and rejects unavailable protection; synthetic test ciphers establish lifecycle only.",
  testEvidence: [TEST, "apps/desktop/tests/unit/bolter-managed-connection.test.ts", "apps/desktop/tests/unit/bolter-spool-cipher.test.ts"],
}];
export const BOLTER_NATIVE_STORAGE_ALARMS: readonly SourceAlarmReview[] = [
  ...["10325b740500612a", "a9c8fa49d956f9d6"].map(fingerprint => ({
    locator: `${MANAGED}#filesystem_write:${fingerprint}:1`, owner: "apps/desktop", closure: "declaration" as const,
    declarationId: `source.bolter-descriptor.${fingerprint}`, reason: "Within source.file.bolter-connection-descriptor, only sealed recovery descriptor ciphertext is written and atomically published by this exact sink. Message text and provider authentication files are outside this descriptor.",
  })),
  ...[
    [`${HANDOVER}#temporary_storage:9dd26a249bd2af09:1`, "handover-endpoint", "This fresh mode-0700 temporary directory contains only the Unix socket endpoint, not a message archive, authentication file or diagnostic log. Message bytes traverse the separately declared transient handover carrier and enter the sealed inbox spool. Close drains admitted work. The explicit socket-removal fallback checks inode identity, but Node close can first unlink its original bound pathname; the owning OS account remains trusted. Empty-directory removal checks identity and never recursively removes replaced or nonempty directories."],
    [`${RUNTIME}#subprocess_processor:b0ca953d0d9928fc:1`, "cli-version", "The exact fixed version command has no account HOME, login, message stdin or credential environment. It compares bounded-by-expected-byte-count release stdout and discards stderr; no provider body is processed."],
    [`${RUNTIME}#filesystem_write:972e179d0755bf73:1`, "cli-artifact-write", "Only public CLI artifact bytes from the pinned HTTPS origin are written, constrained by exact release size and digest, never account credentials or messages."],
    [`${RUNTIME}#filesystem_write:d03202c1e0d07587:1`, "cli-artifact-publish", "This rename publishes only the byte-verified public CLI executable from the exact artifact write. It does not publish provider message or account data."],
    [`${HELPER}#subprocess_processor:95aaafcbbf1599fa:1`, "helper-signature", "The fixed macOS codesign tool verifies the enclosing application seal and helper signature. Its arguments contain local executable paths and signing requirements, with no message, login token or provider credentials; output is retained transiently only for verification."],
    [`${BUILD}#subprocess_processor:dc18a52af7628dde:1`, "helper-compile", "This build-time Bun invocation compiles the fixed app-owned helper source for the two supported macOS architectures; it does not execute a provider login or process user messages."],
    [`${BUILD}#filesystem_write:8872d03a39978864:1`, "helper-manifest", "The build manifest contains only architecture, protocol version, public executable byte count and digest. No user or provider state enters it."],
    [`${FINALIZER}#filesystem_write:ff2763bae2791e66:1`, "migration-finalizer", "This build-time writer emits reviewed static migration SQL. It does not query or serialize database rows, provider accounts, message content or credentials."],
  ].map(([locator, suffix, reason]) => ({ locator: locator!, owner: locator!.startsWith("packages/") ? "packages/db" : "apps/desktop",
    closure: "reviewed_exclusion" as const, exclusionId: `exclusion.bolter-native.${suffix}`, reason: reason! })),
];
