import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BolterConnectionObservation } from "@nautilo/types";
import { BolterConnectionOwner } from "./connection-owner";
import { BolterInboxSpool, type BolterSpoolCipher } from "./inbox-spool";
import { BOLTER_CLI_RELEASE, getBolterProductionDecoders } from "./production-contract";
import { createBolterConnectionDirectories, createBolterPrivateRoot, productionBolterArtifact, provisionBolterRuntime } from "./runtime";
import { bolterNativeAdmissionPolicy, hasBolterNativeQualification, type BolterNativeQualification } from "./native-process";
import type { BolterQualifiedDecoders, BolterCliSelection } from "./cli-contract";
import type { BolterNativeConnectionDriver } from "./relay-port";

const unavailable = () => new Error("Bolter connection is unavailable.");
function identityFingerprint(selection: BolterCliSelection): string {
  return createHash("sha256").update(JSON.stringify([selection.origin, selection.agentId])).digest("hex");
}
type Descriptor = { version: 1; homeHandle: string; identity: BolterCliSelection | null };

/** Electron supplies OS storage and current Human/server; no renderer field selects credentials. */
export function createManagedBolterConnectionFactory(options: {
  readonly appDataDirectory: string; readonly serverId: string; readonly userId: string;
  readonly cipher: BolterSpoolCipher;
  readonly decoders?: BolterQualifiedDecoders | undefined;
  readonly qualification?: BolterNativeQualification | undefined;
  readonly helper?: { executable: string; attest: (executable: string) => Promise<boolean> } | undefined;
}): (input: { connectionId: string; generation: number; homeHandle?: string; isCurrent: () => boolean }) => Promise<BolterNativeConnectionDriver> {
  const config = Object.freeze({ ...options, decoders: options.decoders ? Object.freeze({ ...options.decoders }) : undefined,
    qualification: options.qualification ? Object.freeze({ ...options.qualification }) : undefined,
    helper: options.helper ? Object.freeze({ ...options.helper }) : undefined });
  return async input => {
    const current = input.isCurrent;
    const scope = Object.freeze({ serverId: config.serverId, userId: config.userId, connectionId: input.connectionId });
    if (!current() || !config.cipher.isAvailable()) throw unavailable();
    const root = await createBolterPrivateRoot(config.appDataDirectory, "bolter");
    const records = await createBolterPrivateRoot(root, "connections");
    const key = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
    const path = join(records, `${key}.sealed`);
    const recordDirectory = await lstat(records);
    const check = async () => {
      const stat = await lstat(records);
      if (!current() || !config.cipher.isAvailable() || stat.dev !== recordDirectory.dev || stat.ino !== recordDirectory.ino
        || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw unavailable();
    };
    let descriptor: Descriptor;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw unavailable();
      const decoded: unknown = JSON.parse(await config.cipher.open(await readFile(path)));
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw unavailable();
      const value = decoded as Record<string, unknown>;
      if (Object.keys(value).sort().join() !== "homeHandle,identity,version" || value["version"] !== 1
        || typeof value["homeHandle"] !== "string" || !value["homeHandle"].trim()) throw unavailable();
      const identity = value["identity"] as BolterCliSelection | null;
      if (identity !== null && (!identity || identity.origin !== "https://bolter.chat" || typeof identity.agentId !== "string"
        || !identity.agentId || typeof identity.cliSelector !== "string" || !identity.cliSelector)) throw unavailable();
      descriptor = { version: 1, homeHandle: value["homeHandle"], identity };
      if (input.homeHandle !== undefined && input.homeHandle !== descriptor.homeHandle) throw unavailable();
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT" || input.homeHandle === undefined) throw unavailable();
      descriptor = { version: 1, homeHandle: input.homeHandle, identity: null };
    }
    const persist = async () => {
      await check();
      const ciphertext = await config.cipher.seal(JSON.stringify(descriptor));
      if (!ciphertext.byteLength) throw unavailable();
      const temporary = join(records, `.record-${randomUUID()}`);
      try {
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(ciphertext); await file.sync(); } finally { await file.close(); }
        await check(); await rename(temporary, path);
        const directory = await open(records, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { const stat = await directory.stat(); if (stat.dev !== recordDirectory.dev || stat.ino !== recordDirectory.ino) throw unavailable(); await directory.sync(); }
        finally { await directory.close(); }
        await check();
      } finally { await unlink(temporary).catch(() => undefined); }
    };
    await persist();
    const directories = await createBolterConnectionDirectories(records, scope, descriptor.homeHandle);
    const artifact = productionBolterArtifact(process.platform, process.arch);
    const decoders = config.decoders ?? getBolterProductionDecoders(BOLTER_CLI_RELEASE.version);
    const qualification = config.qualification ?? bolterNativeAdmissionPolicy(BOLTER_CLI_RELEASE.version);
    const qualified = hasBolterNativeQualification(qualification, BOLTER_CLI_RELEASE.version)
      && decoders?.version === BOLTER_CLI_RELEASE.version && !!decoders.identity && !!decoders.discovery && !!decoders.authLink
      && !!decoders.receiveItem && !!decoders.receipt && !!decoders.conversations;
    let owner: BolterConnectionOwner | null = null;
    let retired = false;
    let pending = false;
    let ingressBlocked = false;
    let flush: Promise<unknown> | null = null;
    let dirty = false;
    let ensuring: Promise<void> | null = null;
    const live = () => !retired && current();
    const observation = (): BolterConnectionObservation => {
      const identity = owner?.confirmedIdentity;
      return { runtime: !artifact ? "unavailable" : qualified ? "qualified" : "qualification_required",
        authentication: identity ? "confirmed" : pending ? "pending" : descriptor.identity ? "unknown" : "required",
        identity: identity ? { providerAgentId: identity.agentId, label: "Bolter agent", identityFingerprint: identityFingerprint(identity) } : null,
        receiver: owner?.listening ? "listening" : owner?.state === "receiver-running" ? "running" : "stopped",
        ...(!artifact ? { reason: "runtime_unavailable" as const } : !qualified ? { reason: "qualification_required" as const } : ingressBlocked ? { reason: "receiver_unavailable" as const } : {}) };
    };
    const performEnsure = async () => {
      if (owner || !qualified || !artifact || !live()) return;
      const runtimeRoot = await createBolterPrivateRoot(root, "runtime");
      const executable = await provisionBolterRuntime({ directory: runtimeRoot, artifact, version: BOLTER_CLI_RELEASE.version, isCurrent: live });
      if (!live()) throw unavailable();
      owner = new BolterConnectionOwner({ scope, runtime: { executable, home: directories.home, version: BOLTER_CLI_RELEASE.version,
        platform: process.platform as "darwin" }, decoders, qualification, selection: descriptor.identity ?? undefined,
        isCurrent: live, isBound: () => false,
        // Exact provider bytes are checked before every operation; no raw provider diagnostics escape.
        attest: () => provisionBolterRuntime({ directory: runtimeRoot, artifact, version: BOLTER_CLI_RELEASE.version, isCurrent: live }).then(path => path === executable),
        attestHelper: config.helper?.attest });
    };
    const ensure = () => {
      if (ensuring) return ensuring;
      const work = performEnsure(); ensuring = work;
      void work.finally(() => { if (ensuring === work) ensuring = null; }).catch(() => undefined);
      return work;
    };
    const confirm = async () => {
      await ensure();
      if (!owner || !live()) return observation();
      const expected = descriptor.identity;
      const result = expected ? await owner.confirmIdentity() : await owner.confirmDiscoveredIdentity();
      if (result.status === "confirmed" && live()) {
        const selected = owner.confirmedIdentity;
        if (!selected || expected && identityFingerprint(selected) !== identityFingerprint(expected)) { await owner.retire(); return observation(); }
        descriptor = { ...descriptor, identity: { origin: selected.origin, agentId: selected.agentId, cliSelector: selected.cliSelector } };
        await persist();
      }
      return observation();
    };
    return {
      async connect(onLink) {
        await ensure(); if (!owner || !live()) return observation();
        const found = await confirm(); if (found.authentication === "confirmed") return found;
        const result = await owner.login(auth => { if (live()) { pending = true; onLink(auth); } });
        pending = false;
        return result.status === "awaiting-identity-confirmation" && live() ? confirm() : observation();
      },
      check: confirm,
      async conversations() {
        const result = await confirm();
        if (!owner || result.authentication !== "confirmed") return { kind: "unavailable", reason: qualified ? "identity_unconfirmed" : "qualification_required" };
        const conversations = await owner.listConversations();
        return conversations.status === "available" ? { kind: "conversations", conversations: [...conversations.conversations] }
          : { kind: "unavailable", reason: "qualification_required" };
      },
      async start(accept, onObservation) {
        const result = await confirm();
        if (!owner || result.authentication !== "confirmed" || !config.helper) return { ...result, reason: "receiver_unavailable" };
        const spool = new BolterInboxSpool({ directory: directories.spool, scope, cipher: config.cipher, isCurrent: live });
        const drain = () => {
          dirty = true;
          if (flush || !owner || !live()) return;
          let accepted = true;
          const work = (async () => {
            while (dirty && owner && live()) {
              dirty = false;
              const result = await owner.flushInbox((items, receipt) => accept(items.filter(item => item.type === "message"), receipt.id));
              accepted = result === "accepted";
              if (live() && ingressBlocked !== !accepted) {
                ingressBlocked = !accepted;
                try { onObservation?.(observation()); } catch { /* Observation does not alter durable delivery. */ }
              }
              if (!accepted) break;
            }
          })();
          flush = work;
          void work.then(() => {
            if (flush === work) { flush = null; if (dirty && accepted && live()) drain(); }
          }, () => { if (flush === work) flush = null; });
        };
        const started = await owner.startReceiver({ handoverExecutable: config.helper.executable, directory: directories.handover,
          onStateChange: () => { if (live()) onObservation?.(observation()); },
          spool: { pending: () => spool.pending(), read: id => spool.read(id), acknowledge: receipt => spool.acknowledge(receipt),
            store: async jsonl => { const receipt = await spool.store(jsonl); queueMicrotask(drain); return receipt; } } });
        if (started) drain(); return observation();
      },
      async pause() { await owner?.pauseReceiver(); return observation(); },
      async prepareSend() {
        // Preparation does all asynchronous attestation before the correlated server release.
        const prepared = await owner?.prepareSend();
        return prepared ? async content => {
          const result = await prepared.send({ chatId: content.chatId, threadRootId: content.threadRootId }, content.content);
          return result.status === "sent" ? { kind: "sent", receipt: result.receipt }
            : result.status === "unavailable" ? { kind: "unavailable", reason: "authority_changed" } : { kind: "uncertain" };
        } : null;
      },
      async retire() { retired = true; pending = false; await owner?.retire(); await flush; },
    };
  };
}
