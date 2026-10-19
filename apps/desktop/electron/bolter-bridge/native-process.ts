import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { bolterAttachmentPayloadSchema, type BolterAttachmentPayload } from "@nautilo/types";
import { RELAY_HOST_CONTROL_MAX_BYTES } from "@nautilo/relay";
import { createBolterConversationsInvocation, createBolterDiscoveryInvocation, createBolterIdentityInvocation, createBolterLoginInvocation, createBolterReceiveInvocation,
  createBolterSendInvocation, createBolterFileInvocation, type BolterCliBinding, type BolterCliInvocation, type BolterCliRuntime, type BolterCliSelection } from "./cli-contract";
import type { BolterCliProcessResult } from "./cli-client";

/** Local admission budgets, not claims about provider-supported payload maxima. */
export interface BolterNativeQualification {
  readonly version: string;
  readonly maxOutputBytes: number;
  readonly maxBatchBytes: number;
}
/** Reuses the established Host transport budget; complete encoded frames remain checked separately. */
export function bolterNativeAdmissionPolicy(version: string): BolterNativeQualification {
  return Object.freeze({ version, maxOutputBytes: RELAY_HOST_CONTROL_MAX_BYTES, maxBatchBytes: RELAY_HOST_CONTROL_MAX_BYTES });
}
export type BolterNativeSpawn = (plan: BolterCliInvocation) => ChildProcessWithoutNullStreams;
const unavailable = () => new Error("Bolter native execution is unavailable.");
export function hasBolterNativeQualification(value: BolterNativeQualification | undefined, version: string): boolean {
  return value?.version === version && Number.isSafeInteger(value.maxOutputBytes) && value.maxOutputBytes > 0
    && Number.isSafeInteger(value.maxBatchBytes) && value.maxBatchBytes > 0;
}

function fixedPlan(plan: BolterCliInvocation, runtime: BolterCliRuntime, helper?: string): boolean {
  const args = plan.args;
  let expected: ReturnType<typeof createBolterLoginInvocation>;
  const cliSelector = args[args.indexOf("--agent") + 1] ?? "";
  // Canonical IDs do not enter argv. Plan reconstruction validates the explicit selector only.
  const selection = { origin: args[args.indexOf("--url") + 1] ?? "", agentId: "plan-identity", cliSelector };
  switch (args[0]) {
    case "login": expected = createBolterLoginInvocation(runtime); break;
    case "agents": expected = createBolterDiscoveryInvocation(runtime); break;
    case "chats": expected = createBolterConversationsInvocation(runtime, selection); break;
    case "me": expected = createBolterIdentityInvocation(runtime, selection); break;
    case "serve":
      if (!helper) return false;
      expected = createBolterReceiveInvocation(runtime, selection, helper); break;
    case "call": {
      let input: unknown;
      try { input = JSON.parse(plan.stdin); } catch { return false; }
      if (!input || typeof input !== "object" || Array.isArray(input) || !("content" in input) || typeof input.content !== "string") return false;
      if (args[1] === "files_create_file") {
        if (Object.keys(input).length !== 3 || !("path" in input) || typeof input.path !== "string"
          || !("mime_type" in input) || typeof input.mime_type !== "string") return false;
        expected = createBolterFileInvocation(runtime, selection, { chatId: args[args.indexOf("--chat") + 1] ?? "",
          threadRootId: args.includes("--thread") ? args[args.indexOf("--thread") + 1] ?? "" : null },
          { path: input.path, mimeType: input.mime_type, content: input.content }); break;
      }
      if (Object.keys(input).length !== 1) return false;
      expected = createBolterSendInvocation(runtime, selection, {
        chatId: args[args.indexOf("--chat") + 1] ?? "",
        threadRootId: args.includes("--thread") ? args[args.indexOf("--thread") + 1] ?? "" : null,
      }, input.content); break;
    }
    default: return false;
  }
  return expected.ok && plan.executable === expected.value.executable && plan.shell === false
    && plan.stdin === expected.value.stdin && JSON.stringify(plan.args) === JSON.stringify(expected.value.args)
    && Object.keys(plan.env).length === Object.keys(expected.value.env).length
    && Object.entries(expected.value.env).every(([key, value]) => plan.env[key] === value);
}

export interface BolterNativeChild {
  readonly result: Promise<BolterCliProcessResult>;
  /** Resolves only after close, including pipe closure. No timer declares a child stopped. */
  stop(): Promise<void>;
}

/** Electron owns the children. This runner is neither a daemon nor a general command executor. */
export class BolterNativeProcessOwner {
  private readonly runtime: BolterCliRuntime;
  private readonly qualification: BolterNativeQualification | undefined;
  private readonly children = new Set<BolterNativeChild>();
  private retired = false;
  private retirement: Promise<void> | undefined;
  private readonly spawnChild: BolterNativeSpawn;
  constructor(private readonly options: {
    runtime: BolterCliRuntime;
    qualification?: BolterNativeQualification | undefined;
    attest: (plan: BolterCliInvocation) => Promise<boolean>;
    /** Must attest the app-owned helper bytes; the CLI executable check alone is insufficient. */
    attestHelper?: ((executable: string) => Promise<boolean>) | undefined;
    isCurrent: () => boolean;
    spawn?: BolterNativeSpawn | undefined;
  }) {
    this.runtime = { ...options.runtime };
    this.qualification = options.qualification ? { ...options.qualification } : undefined;
    this.options = { ...options };
    this.spawnChild = options.spawn ?? (plan => spawn(plan.executable, [...plan.args], {
      shell: false, env: { ...plan.env }, stdio: ["pipe", "pipe", "pipe"],
    }));
  }
  isCurrent(): boolean {
    try { return !this.retired && this.options.isCurrent() === true; } catch { return false; }
  }
  async start(plan: BolterCliInvocation, receive?: {
    readonly helper: string;
    readonly descriptor: string;
  }, onStdout?: (text: string) => void, additionalCurrent?: () => boolean): Promise<BolterNativeChild> {
    const handover = receive ? Object.freeze({ helper: receive.helper, descriptor: receive.descriptor }) : undefined;
    const current = () => { try { return this.isCurrent() && (additionalCurrent?.() ?? true); } catch { return false; } };
    // Snapshot before the asynchronous attestation; callers cannot change argv after approval.
    const pinned: BolterCliInvocation = Object.freeze({ executable: plan.executable,
      args: Object.freeze([...plan.args]), stdin: plan.stdin, shell: plan.shell,
      env: Object.freeze({ ...plan.env }) });
    if (!current() || !hasBolterNativeQualification(this.qualification, this.runtime.version)
      || !fixedPlan(pinned, this.runtime, handover?.helper) || (handover !== undefined && pinned.args[0] !== "serve")) throw unavailable();
    const invocation: BolterCliInvocation = handover === undefined ? pinned : Object.freeze({ ...pinned,
      env: Object.freeze({ ...pinned.env, NAUTILO_BOLTER_HANDOVER: handover.descriptor }) });
    try {
      if (!await this.options.attest(invocation)) throw unavailable();
      if (handover && (!this.options.attestHelper || !await this.options.attestHelper(handover.helper))) throw unavailable();
    } catch { throw unavailable(); }
    if (!current()) throw unavailable();
    return this.launch(invocation, handover === undefined, current, onStdout);
  }

  /** Attest before server content release. The resulting capability admits one immediate fixed send. */
  async prepareSend(selection: BolterCliSelection, additionalCurrent: () => boolean): Promise<{
    execute(binding: BolterCliBinding, content: string): Promise<BolterCliProcessResult>;
  }> {
    const selected = Object.freeze({ ...selection });
    const current = () => { try { return this.isCurrent() && additionalCurrent(); } catch { return false; } };
    const plan = createBolterIdentityInvocation(this.runtime, selected);
    if (!current() || !hasBolterNativeQualification(this.qualification, this.runtime.version) || !plan.ok) throw unavailable();
    try { if (!await this.options.attest(plan.value)) throw unavailable(); } catch { throw unavailable(); }
    if (!current()) throw unavailable();
    let used = false;
    return Object.freeze({ execute: (binding: BolterCliBinding, content: string) => {
      if (used) return Promise.reject(unavailable());
      used = true;
      const send = createBolterSendInvocation(this.runtime, selected, { ...binding }, content);
      if (!send.ok || !current()) return Promise.reject(unavailable());
      // No asynchronous attestation, queue or callback precedes this exact native spawn.
      try { return this.launch(send.value, true, current).result; } catch { return Promise.reject(unavailable()); }
    } });
  }

  /** Prepare one upload, then let the server reauthorize before its immediate native spawn. */
  async prepareFileUpload(selection: BolterCliSelection, binding: BolterCliBinding, file: BolterAttachmentPayload,
    additionalCurrent: () => boolean): Promise<{ execute(): Promise<BolterCliProcessResult> }> {
    const parsed = bolterAttachmentPayloadSchema.safeParse(file);
    if (!parsed.success) throw unavailable();
    const bytes = Buffer.from(file.base64, "base64");
    if (bytes.toString("base64") !== file.base64 || bytes.length !== file.sizeBytes
      || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw unavailable();
    const name = file.filename.split(/[/\\]/u).at(-1) || "attachment";
    // Bolter storage paths accept ASCII names; the share label retains the original filename.
    const slug = name.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
    const storageName = /^[A-Za-z0-9]/u.test(slug) ? slug : `attachment${slug}`;
    const isText = file.mimeType.startsWith("text/") || ["application/json", "application/yaml", "application/toml"].includes(file.mimeType);
    const content = isText ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) : file.base64;
    const plan = createBolterFileInvocation(this.runtime, selection, binding, { path: `/nautilo/${file.id}/${storageName}`, mimeType: file.mimeType, content });
    const current = () => this.isCurrent() && additionalCurrent();
    if (!plan.ok || !current() || !hasBolterNativeQualification(this.qualification, this.runtime.version)) throw unavailable();
    if (!await this.options.attest(plan.value) || !current()) throw unavailable();
    let used = false;
    return Object.freeze({ execute: () => {
      if (used || !current()) return Promise.reject(unavailable());
      used = true;
      return this.launch(plan.value, true, current).result;
    } });
  }

  private launch(invocation: BolterCliInvocation, stdout: boolean, current: () => boolean,
    onStdout?: (text: string) => void): BolterNativeChild {
    if (!current()) throw unavailable();
    let process: ChildProcessWithoutNullStreams;
    try { process = this.spawnChild(invocation); } catch { throw unavailable(); }
    let failed = false;
    let output = "";
    let outputBytes = 0;
    let settle!: (result: BolterCliProcessResult) => void;
    const result = new Promise<BolterCliProcessResult>(resolve => { settle = resolve; });
    const stop = () => {
      try { if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM"); } catch { /* Still wait for actual close. */ }
      return result.then(() => undefined);
    };
    const child: BolterNativeChild = { result, stop };
    this.children.add(child);
    process.on("error", () => { failed = true; void stop(); });
    process.stdin.on("error", () => { failed = true; void stop(); });
    process.stdout.on("error", () => { failed = true; void stop(); });
    process.stderr.on("error", () => { failed = true; void stop(); });
    process.stderr.resume(); // Never retain or expose provider diagnostic output.
    if (stdout) {
      process.stdout.setEncoding("utf8");
      process.stdout.on("data", (chunk: string) => {
        if (failed) return;
        outputBytes += Buffer.byteLength(chunk);
        if (!current() || outputBytes > this.qualification!.maxOutputBytes) {
          failed = true; output = ""; void stop(); return;
        }
        output += chunk;
        try { onStdout?.(output); } catch { failed = true; output = ""; void stop(); }
      });
    } else process.stdout.resume(); // Receiver batch content travels only over handover IPC.
    process.once("close", (code: number | null) => {
      this.children.delete(child);
      const valid = !failed && current();
      settle({ exitCode: valid ? code : null, stdout: valid ? output : "", stderr: "" });
      output = "";
    });
    if (!current()) { failed = true; void stop(); }
    else process.stdin.end(invocation.stdin);
    return child;
  }
  async execute(plan: BolterCliInvocation, additionalCurrent?: () => boolean): Promise<BolterCliProcessResult> {
    return (await this.start(plan, undefined, undefined, additionalCurrent)).result;
  }
  retire(): Promise<void> {
    this.retired = true;
    this.retirement ??= Promise.all([...this.children].map(child => child.stop())).then(() => undefined);
    return this.retirement;
  }
}
