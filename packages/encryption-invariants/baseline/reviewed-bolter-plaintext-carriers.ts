import type { AuthorizedPlaintextCoverageEntry } from "../src/model";
import type { SourceAlarmReview } from "../src/node/source-alarm-review";
import type { SourceDeclaration } from "../src/node/source-inventory";

const REVIEW = "packages/encryption-invariants/tests/integration/bolter-plaintext-carriers.test.ts";
const NATIVE = "apps/desktop/electron/bolter-bridge/native-process.ts";
const CONNECTION = "apps/desktop/electron/bolter-bridge/connection-owner.ts";
const HANDOVER = "apps/desktop/electron/bolter-bridge/handover.ts";
const HELPER = "apps/desktop/electron/bolter-bridge/handover-main.ts";
const WIRE = "packages/relay/src/bolter-protocol.ts";
const TRANSPORT = "packages/runtime/src/bolter-relay.ts";
const CONTROLLER = "packages/server/src/messaging/bolter-controller.ts";
const PUBLICATION = "packages/server/src/messaging/bolter-publication.ts";

/** Exact current carriers, including socket and stdin sinks the heuristic does not detect. */
export const BOLTER_PLAINTEXT_SOURCE_DECLARATIONS: readonly SourceDeclaration[] = [
  { id: "source.bolter.native-process", surface: "processor", locator: `${NATIVE}#BolterNativeProcessOwner`, role: "processor",
    evidence: [{ path: NATIVE, symbols: ["spawn(plan.executable", "process.stdin.end(invocation.stdin)", "process.stdout.on(\"data\"", "process.stderr.resume()", "output = \"\"", "hasBolterNativeQualification"] }] },
  { id: "source.bolter.connection-owner", surface: "processor", locator: `${CONNECTION}#BolterConnectionOwner`, role: "processor",
    evidence: [{ path: CONNECTION, symbols: ["class BolterConnectionOwner", "spool.read(id)", "decodeBolterReceiveBatch(batch.jsonl", "accept(decoded.value", "spool.acknowledge", "this.boundCallback(destination)"] }] },
  { id: "source.bolter.handover", surface: "wire", locator: `${HANDOVER}#authenticated-generation-handover`, role: "processor",
    evidence: [{ path: HANDOVER, symbols: ["createBolterHandoverServer", "handOverBolterBatch", "createServer", "createConnection", "randomBytes(32)", "(directory.mode & 0o077) !== 0", "await store(jsonl)", "socket.write(Buffer.concat", "await Promise.allSettled([...pending])"] }] },
  { id: "source.bolter.handover-helper", surface: "processor", locator: `${HELPER}#runBolterHandover`, role: "processor",
    evidence: [{ path: HELPER, symbols: ["runBolterHandover", "delete process.env[\"NAUTILO_BOLTER_HANDOVER\"]", "process.stdin", "process.exitCode"] }] },
  { id: "source.bolter.relay-wire", surface: "wire", locator: `${WIRE}#finite-adapter-wire`, role: "processor",
    evidence: [{ path: WIRE, symbols: ["RelayBolterAuthorized", "RelayBolterBatch", "parseRelayBolterDesktopMessage", "sameRelayBolterScope", "BOLTER_RELAY_MAX_FRAME_BYTES"] },
      { path: "packages/relay/src/client.ts", symbols: ["bolterTransport", "reconcileBolterHost", "deactivateBolterHost", "sameRelayBolterScope(parsed.scope, bolterSession)"] }] },
  { id: "source.bolter.relay-transport", surface: "wire", locator: `${TRANSPORT}#BolterRelayTransport`, role: "processor",
    evidence: [{ path: TRANSPORT, symbols: ["class BolterRelayTransport", "pending.authorizationUsed = true", "await pending.authorize()", "this.pending.get(message.correlationId) !== pending", "await this.batchListener", "sameRelayBolterScope(session, current)"] }] },
  { id: "source.bolter.controller", surface: "processor", locator: `${CONTROLLER}#createBolterController`, role: "processor",
    evidence: [{ path: CONTROLLER, symbols: ["createBolterController", "assertExternalRoomTextMode", "acceptBolterReviewedShareWith", "request.authorize()", "onBolterBatch", "observations.clear()", "operations.clear()"] }] },
  { id: "source.bolter.publication", surface: "wire", locator: `${PUBLICATION}#createBolterPublicationService`, role: "emitter",
    evidence: [{ path: PUBLICATION, symbols: ["createBolterPublicationService", "transport.send", "authorizationUsed", "await store.load(receiver, claim)", "receipt.chatId !== destination.chatId", "loadBolterPublicationContentWith"] },
      { path: "packages/db/src/queries/bolter-bridge.ts", symbols: ["async function externalPlaintextFence", "policy.mode !== \"plaintext_only\"", "export function loadBolterPublicationContentWith", "await externalPlaintextFence(tx)", "bolterReviewedTextFingerprint(binding.id, share.requestId, message.content)"] }] },
];

const localModeGate = "Canonical server intake and outgoing publication independently require externalPlaintextFence plaintext_only. Local CLI login, receive and encrypted spooling do not themselves enforce the server mode. Injected native qualification and decoders are mandatory; the live provider contract remains unqualified, and protected-mode bridging is unsupported.";

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
    id: "source.bolter.relay-wire",
    recipientAuthority: "Strict directional frames carry normalized external messages or late-authorized exact text on the existing authenticated Desktop socket and private Host pipe. The six-field current session, explicit Electron capability and negotiated protocol fence every frame. This is not a model tool lane; credentials and local HOME paths are absent.",
    cleanupContract: "Frames are transient WebSocket, private-pipe and process buffers. The Relay does not archive bodies or emit body diagnostics. Disconnect retires the port and rejects the old scope; transport encryption does not establish Namespace encryption, provider erasure or JavaScript string zeroization.",
    tests: ["packages/relay/tests/unit/bolter-protocol.test.ts", "packages/relay/tests/unit/client-bolter.test.ts", "packages/server/tests/unit/relay-endpoint-bolter.test.ts"],
  },
  {
    id: "source.bolter.relay-transport",
    recipientAuthority: "The exact authenticated Human, Relay, pairing, Desktop, socket and capability revision bind each command. The preparation command has no text. The native ready request may consume one active publication authorization, then the session and pending command are rechecked before releasing its exact destination and content. A receive ACK follows the sole canonical durable-admission consumer.",
    cleanupContract: "Pending commands retain correlation and authorization callbacks until result, abort or session retirement. Content and received batches are transient; no plaintext body store or diagnostic output is created. Concurrent handover is blocked, unaccepted ciphertext remains on Desktop, and interrupted sends are never retried. Injected consumers can retain references; heap zeroization is not claimed.",
    tests: ["packages/runtime/tests/unit/bolter-relay.test.ts", "packages/runtime/tests/unit/relay-registry-bolter.test.ts"],
  },
  {
    id: "source.bolter.controller",
    recipientAuthority: "Authenticated owner routes and server-issued conversation choices select fresh private external-context Rooms. Canonical intake and publication enforce current binding, exact generation, sponsorship and plaintext-only mode. Reviewed text is committed as one canonical Human message plus an immutable metadata grant; external data cannot mint that grant or choose an internal Namespace.",
    cleanupContract: "The controller adds no durable plaintext archive. Transient observation labels and login links are owner scoped, invalidated on authority change and cleared at close. Canonical messages, outbox metadata and OS-protected inbox storage are separately reviewed. Late publication authorization admits an in-flight disclosure that cannot be recalled; unknown outcomes are not replayed. No heap zeroization or provider-erasure claim is made.",
    tests: ["packages/server/tests/unit/bolter-routes.test.ts", "packages/db/tests/unit/bolter-reviewed-share.test.ts"],
  },
  {
    id: "source.bolter.publication",
    recipientAuthority: "One current owner-bound outbox claim authorizes one canonical final reply or an exact append-only Human reviewed-share grant for the exact provider agent, chat and thread, with current binding revision, sponsorship and recomputed content fingerprint. A causal reply additionally requires its accepted source receipt and completed Job; a reviewed Human message requires its exact immutable share grant. The fixed Desktop transport must fence its receiver immediately before dispatch; arbitrary explicit-share IDs cannot authorize disclosure. Late single-use authorization is the dispatch boundary; an already admitted disclosure may finish after pause or mode transition.",
    cleanupContract: "The service adds no durable plaintext retention to the one-shot transport attempt. The durable outbox retains canonical message references and lifecycle metadata, not another body. The service emits no diagnostics or body archive; uncertain dispatch or lost settlement is never automatically replayed. Trusted injected ports can retain references and the recipient provider may retain delivered content outside Nautilo's custody; heap zeroization or remote erasure is not claimed.",
    tests: ["packages/server/tests/unit/bolter-publication.test.ts", "packages/db/tests/unit/bolter-execution.test.ts"],
  },
] as const;

export const BOLTER_PLAINTEXT_COVERAGE: readonly AuthorizedPlaintextCoverageEntry[] =
  contracts.map(contract => {
    const source = BOLTER_PLAINTEXT_SOURCE_DECLARATIONS.find(item => item.id === contract.id)!;
    const owner = source.locator.startsWith("apps/") ? "apps/desktop" : source.locator.split("/").slice(0, 2).join("/");
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

export const BOLTER_PLAINTEXT_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  ...["2e3fb5648c60f344", "1e8eb4c3bf4a0ace", "039e6dad130a8e92"].map(fingerprint => ({
    locator: `${CONTROLLER}#log_emitter:${fingerprint}:1`, owner: "packages/server", closure: "reviewed_exclusion" as const,
    exclusionId: `exclusion.bolter-controller.${fingerprint}`,
    reason: "This exact diagnostic is a fixed recovery-state literal with no interpolation, error details, provider text, labels, identity, routing coordinates, credentials or key material. Canonical message and adapter wire content have separate explicit declarations.",
  })),
  {
  locator: `${NATIVE}#subprocess_processor:c598ac96cc3f3550:1`, owner: "apps/desktop", closure: "declaration",
  declarationId: "source.bolter.native-process",
  reason: "This fixed attested CLI processes real plaintext through owned stdin/stdout pipes, with current-generation admission and provider-version qualification. It is an authorized transient plaintext carrier, not a content-free subprocess, encrypted processor or frozen debt waiver.",
}];
