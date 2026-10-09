import type { AuthorizedPlaintextCoverageEntry } from "../src/model";
import type { SourceAlarmReview } from "../src/node/source-alarm-review";
import type { SourceDeclaration } from "../src/node/source-inventory";

const REVIEW = "packages/encryption-invariants/tests/integration/bolter-plaintext-carriers.test.ts";
const NATIVE = "apps/desktop/electron/bolter-bridge/native-process.ts";
const CONNECTION = "apps/desktop/electron/bolter-bridge/connection-owner.ts";
const HANDOVER = "apps/desktop/electron/bolter-bridge/handover.ts";
const HELPER = "apps/desktop/electron/bolter-bridge/handover-main.ts";
const PUBLICATION = "packages/server/src/messaging/bolter-publication.ts";

/** Exact current carriers, including socket and stdin sinks the heuristic does not detect. */
export const BOLTER_PLAINTEXT_SOURCE_DECLARATIONS: readonly SourceDeclaration[] = [
  { id: "source.bolter.native-process", surface: "processor", locator: `${NATIVE}#BolterNativeProcessOwner`, role: "processor",
    evidence: [{ path: NATIVE, symbols: ["spawn(plan.executable", "process.stdin.end(pinned.stdin)", "process.stdout.on(\"data\"", "process.stderr.resume()", "output = \"\"", "hasBolterNativeQualification"] }] },
  { id: "source.bolter.connection-owner", surface: "processor", locator: `${CONNECTION}#BolterConnectionOwner`, role: "processor",
    evidence: [{ path: CONNECTION, symbols: ["class BolterConnectionOwner", "spool.read(id)", "decodeBolterReceiveBatch(batch.jsonl", "accept(decoded.value", "spool.acknowledge", "this.boundCallback(destination)"] }] },
  { id: "source.bolter.handover", surface: "wire", locator: `${HANDOVER}#authenticated-generation-handover`, role: "processor",
    evidence: [{ path: HANDOVER, symbols: ["createBolterHandoverServer", "handOverBolterBatch", "createServer", "createConnection", "randomBytes(32)", "(directory.mode & 0o077) !== 0", "await store(jsonl)", "socket.write(Buffer.concat", "await Promise.allSettled([...pending])"] }] },
  { id: "source.bolter.handover-helper", surface: "processor", locator: `${HELPER}#runBolterHandover`, role: "processor",
    evidence: [{ path: HELPER, symbols: ["runBolterHandover", "delete process.env[\"NAUTILO_BOLTER_HANDOVER\"]", "process.stdin", "process.exitCode"] }] },
  { id: "source.bolter.publication", surface: "wire", locator: `${PUBLICATION}#createBolterPublicationService`, role: "emitter",
    evidence: [{ path: PUBLICATION, symbols: ["createBolterPublicationService", "transport.send", "authorizationUsed", "await store.load(receiver, claim)", "receipt.chatId !== destination.chatId", "loadBolterPublicationContentWith"] },
      { path: "packages/db/src/queries/bolter-bridge.ts", symbols: ["async function externalPlaintextFence", "policy.mode !== \"plaintext_only\"", "export function loadBolterPublicationContentWith", "await externalPlaintextFence(tx)", "candidate.explicitShareId !== null"] }] },
];

const localModeGate = "Canonical server intake and outgoing publication independently require externalPlaintextFence plaintext_only. Local CLI login, receive and encrypted spooling do not themselves enforce the server mode. Injected native qualification and decoders are mandatory; production wiring and live provider qualification remain unavailable, and protected-mode bridging is unsupported.";

const contracts = [
  {
    id: "source.bolter.native-process",
    recipientAuthority: "An attested app-owned CLI and helper receive fixed shell-free argv, private pipes and generation-scoped environment. The current receiver is checked after asynchronous attestation and before spawn; the owner supplies the exact bound destination. Login stdout can include an authentication link and must not be described as content-free.",
    cleanupContract: "Stderr and receiver stdout are drained without retention. Other stdout is transiently returned only to the qualified decoder, and the runner drops its buffer at close or rejection. Retirement waits for child and pipe closure; JavaScript string zeroization is not claimed.",
    tests: ["apps/desktop/tests/unit/bolter-native-process.test.ts"],
  },
  {
    id: "source.bolter.connection-owner",
    recipientAuthority: "The exact immutable server, Human, connection and provider identity bind the confirmed current receiver. Sending rechecks the exact chat and thread at the native spawn fence; inbound decoded plaintext is handed only to the injected canonical admission port.",
    cleanupContract: "Decoded and decrypted batches remain transient in this owner. The sole durable batch handoff is the separately reviewed safeStorage ciphertext spool through its trusted cipher port, not a plaintext archive. Spool deletion requires canonical acceptance; retirement retains unaccepted ciphertext and drains pending work.",
    tests: ["apps/desktop/tests/unit/bolter-connection-owner.test.ts", "apps/desktop/tests/unit/bolter-inbox-spool.test.ts", "apps/desktop/tests/unit/bolter-spool-cipher.test.ts"],
  },
  {
    id: "source.bolter.handover",
    recipientAuthority: "An owned nonsymlink mode-0700 directory and per-generation nonce authenticate the fixed local Unix socket handover for the exact server, Human and connection. The descriptor is passed in the attested helper environment, not argv. Authentication and OS locality do not encrypt stdin, socket bytes or heap buffers.",
    cleanupContract: "The socket carries the raw complete UTF-8 batch in memory to the trusted encrypted spool store. Acknowledgment follows durable store; closure drains admitted stores and closes the owned endpoint. Node can automatically unlink its bound pathname on close; only the explicit fallback unlink checks the inode, so the parent directory must remain under trusted ownership. No plaintext body file is created here, and heap zeroization is not claimed.",
    tests: ["apps/desktop/tests/unit/bolter-handover.test.ts", "apps/desktop/tests/unit/bolter-connection-owner.test.ts"],
  },
  {
    id: "source.bolter.handover-helper",
    recipientAuthority: "The app-attested fixed helper reads the exact generation descriptor from environment, removes that environment entry and passes its raw stdin batch only to the authenticated private Unix socket. No model tool or arbitrary subprocess interface is exposed.",
    cleanupContract: "Stdin and socket payloads are transient process memory and pipes. The helper returns only success or failure through its exit code and creates no body archive or diagnostic output; process exit releases memory without a zeroization claim.",
    tests: ["apps/desktop/tests/unit/bolter-handover.test.ts"],
  },
  {
    id: "source.bolter.publication",
    recipientAuthority: "One current owner-bound outbox claim authorizes one canonical final reply for the exact provider agent, chat and thread, with current binding revision, sponsorship, accepted source receipt, completed Job and recomputed content fingerprint. The fixed Desktop transport must fence its receiver immediately before dispatch; arbitrary explicit-share IDs cannot authorize disclosure.",
    cleanupContract: "The service adds no durable plaintext retention to the one-shot transport attempt. The durable outbox retains canonical message references and lifecycle metadata, not another body. The service emits no diagnostics or body archive; uncertain dispatch or lost settlement is never automatically replayed. Trusted injected ports can retain references and the recipient provider may retain delivered content outside Nautilo's custody; heap zeroization or remote erasure is not claimed.",
    tests: ["packages/server/tests/unit/bolter-publication.test.ts", "packages/db/tests/unit/bolter-execution.test.ts"],
  },
] as const;

export const BOLTER_PLAINTEXT_COVERAGE: readonly AuthorizedPlaintextCoverageEntry[] =
  contracts.map(contract => {
    const source = BOLTER_PLAINTEXT_SOURCE_DECLARATIONS.find(item => item.id === contract.id)!;
    const owner = source.locator.startsWith("apps/") ? "apps/desktop" : "packages/server";
    return {
      id: contract.id, surface: source.surface as "processor" | "wire", locator: source.locator, owner,
      readers: source.evidence.map(item => item.path), writers: [source.evidence[0]!.path],
      classification: "authorized_plaintext", mode: "plaintext_only", transientOnly: true,
      modeGate: source.id === "source.bolter.publication"
        ? "loadBolterPublicationContentWith acquires the canonical encryption consumption fence and rejects every mode other than plaintext_only before hydrating or releasing any canonical body. Native dispatch separately rechecks current receiver authority; no protected-mode export or production activation is claimed."
        : localModeGate,
      recipientAuthority: contract.recipientAuthority, cleanupContract: contract.cleanupContract,
      noRetentionTestEvidence: [...contract.tests, REVIEW], testEvidence: [...contract.tests, REVIEW],
      migrationState: "not_applicable", releaseImpact: "blocks_whole_product_claim",
      retention: "Plaintext exists transiently in local pipes, Unix IPC or process memory for an authorized operation. Canonical storage and the encrypted durable inbox spool have separate coverage; this carrier provides no encryption or provider-retention guarantee.",
    };
  });

export const BOLTER_PLAINTEXT_SOURCE_ALARMS: readonly SourceAlarmReview[] = [{
  locator: `${NATIVE}#subprocess_processor:c598ac96cc3f3550:1`, owner: "apps/desktop", closure: "declaration",
  declarationId: "source.bolter.native-process",
  reason: "This fixed attested CLI processes real plaintext through owned stdin/stdout pipes, with current-generation admission and provider-version qualification. It is an authorized transient plaintext carrier, not a content-free subprocess, encrypted processor or frozen debt waiver.",
}];
