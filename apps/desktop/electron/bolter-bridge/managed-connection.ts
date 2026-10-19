import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BolterConnectionObservation } from "@nautilo/types";
import { BolterConnectionOwner } from "./connection-owner";
import { BolterInboxSpool, type BolterSpoolCipher } from "./inbox-spool";
import { getBolterProductionDecoders } from "./production-contract";
import { createBolterConnectionDirectories, createBolterPrivateRoot, productionBolterPlatform, provisionLatestBolterRuntime, attestBolterRuntime, type BolterInstalledRuntime } from "./runtime";
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
    const platform = productionBolterPlatform(process.platform, process.arch);
    let installed: BolterInstalledRuntime | null = null;
    let owner: BolterConnectionOwner | null = null;
    let ownerController: AbortController | null = null;
    let revision = 0;
    let qualified = !config.decoders || !!config.decoders.identity && !!config.decoders.discovery && !!config.decoders.authLink
      && !!config.decoders.receiveItem && !!config.decoders.receipt && !!config.decoders.conversations;
    let retired = false;
    let pending = false;
    let ingressBlocked = false;
    let flush: Promise<unknown> | null = null;
    let ensuring: Promise<void> | null = null;
    let acquisitionController: AbortController | null = null;
    let recovering: Promise<boolean> | null = null;
    let receiverIntent = 0;
    let receiverWanted = false;
    let receiverRecoveryUsed = false;
    let resumeReceiver: (() => Promise<boolean>) | null = null;
    const live = () => !retired && current();
    const observation = (): BolterConnectionObservation => {
      const identity = owner?.confirmedIdentity;
      return { runtime: !platform ? "unavailable" : qualified ? "qualified" : "qualification_required",
        authentication: identity ? "confirmed" : pending ? "pending" : descriptor.identity ? "unknown" : "required",
        identity: identity ? { providerAgentId: identity.agentId, label: identity.label ?? "Bolter agent", identityFingerprint: identityFingerprint(identity) } : null,
        receiver: owner?.listening ? "listening" : owner?.state === "receiver-running" ? "running" : "stopped",
        attachments: owner?.canShareFiles === true,
        ...(!platform ? { reason: "runtime_unavailable" as const } : !qualified ? { reason: "qualification_required" as const } : ingressBlocked ? { reason: "receiver_unavailable" as const } : {}) };
    };
    const performEnsure = async (refresh: boolean) => {
      if ((!refresh && owner) || !qualified || !platform || !live()) return;
      const controller = new AbortController();
      acquisitionController = controller;
      const runtimeRoot = await createBolterPrivateRoot(root, "runtime");
      const next = await provisionLatestBolterRuntime({ directory: runtimeRoot, platform, isCurrent: live, signal: controller.signal });
      if (!live() || controller.signal.aborted) throw unavailable();
      if (owner && installed?.version === next.version) return;
      const decoders = config.decoders ?? getBolterProductionDecoders(next.version);
      const qualification = config.qualification ?? bolterNativeAdmissionPolicy(next.version);
      const nextQualified = hasBolterNativeQualification(qualification, next.version)
        && decoders?.version === next.version && !!decoders.identity && !!decoders.discovery && !!decoders.authLink
        && !!decoders.receiveItem && !!decoders.receipt && !!decoders.conversations;
      if (!nextQualified) { if (!owner) qualified = false; return; }
      // Retire the old authority before another process can access the same credential HOME.
      const previous = owner;
      const previousController = ownerController;
      const epoch = ++revision;
      owner = null; ownerController = null;
      previousController?.abort();
      await previous?.retire();
      await flush;
      if (!live() || controller.signal.aborted || epoch !== revision) throw unavailable();
      installed = next;
      const lifetime = new AbortController();
      ownerController = lifetime;
      owner = new BolterConnectionOwner({ scope, runtime: { executable: next.executable, home: directories.home,
        version: next.version, platform: "darwin" }, decoders, qualification, selection: descriptor.identity ?? undefined,
        isCurrent: () => live() && epoch === revision, isBound: () => false,
        // Attestation is local; downloading never occurs at the send authorization fence.
        attest: () => attestBolterRuntime({ directory: runtimeRoot, runtime: next, isCurrent: () => live() && epoch === revision, signal: lifetime.signal }),
        attestHelper: config.helper?.attest });
    };
    const ensure = (refresh = false): Promise<void> => {
      if (ensuring) {
        if (acquisitionController?.signal.aborted && live()) return ensuring.catch(() => undefined).then(() => ensure(refresh));
        return ensuring;
      }
      if (!refresh && owner) return Promise.resolve();
      const work = performEnsure(refresh); ensuring = work;
      void work.finally(() => { if (ensuring === work) ensuring = null; }).catch(() => undefined);
      return work;
    };
    const confirmOnce = async () => {
      const target = owner;
      if (!target || !live()) return observation();
      const expected = descriptor.identity;
      const result = expected ? await target.confirmIdentity() : await target.confirmDiscoveredIdentity();
      if (result.status === "confirmed" && live() && owner === target) {
        const selected = target.confirmedIdentity;
        if (!selected || expected && identityFingerprint(selected) !== identityFingerprint(expected)) {
          ++revision; owner = null; ownerController?.abort(); ownerController = null;
          await target.retire(); return observation();
        }
        descriptor = { ...descriptor, identity: { origin: selected.origin, agentId: selected.agentId, cliSelector: selected.cliSelector } };
        await persist();
      }
      return observation();
    };
    const recover = async (failedVersion: string | undefined, resume = true, allowLogin = false): Promise<boolean> => {
      if (!live() || !failedVersion) return false;
      let work = recovering;
      if (!work) {
        work = (async () => {
          if (installed?.version === failedVersion) await ensure(true);
          return live() && !!owner && installed?.version !== failedVersion;
        })();
        recovering = work;
        const acquisition = work;
        void work.finally(() => { if (recovering === acquisition) recovering = null; }).catch(() => undefined);
      }
      // Only acquisition is shared. Each caller retains its own login/restart policy.
      if (!await work || !live() || installed?.version === failedVersion) return false;
      const result = await confirmOnce();
      if (!live() || result.authentication !== "confirmed" && !allowLogin) return false;
      if (resume && receiverWanted) await resumeReceiver?.();
      return true;
    };
    const confirm = async () => {
      await ensure();
      const version = installed?.version;
      const result = await confirmOnce();
      // An empty credential HOME is normal before login, not an upgrade failure.
      if (result.authentication !== "confirmed" && descriptor.identity && await recover(version)) return observation();
      return result;
    };
    return {
      async connect(onLink) {
        await ensure(true); if (!owner || !live()) return observation();
        const found = await confirmOnce();
        if (found.authentication === "confirmed") {
          if (receiverWanted && owner.state !== "receiver-running") await resumeReceiver?.();
          return observation();
        }
        const login = async () => {
          const result = await owner?.login(auth => { if (live()) { pending = true; onLink(auth); } });
          pending = false;
          return result;
        };
        const version = installed?.version;
        let result = await login();
        if (result?.status === "unavailable" && await recover(version, false, true)) result = await login();
        if (result?.status === "awaiting-identity-confirmation" && live()) {
          const confirmed = await confirmOnce();
          if (confirmed.authentication === "confirmed" && receiverWanted) await resumeReceiver?.();
          return observation();
        }
        return observation();
      },
      check: confirm,
      async conversations() {
        const list = async () => {
          await ensure();
          const result = await confirmOnce();
          if (!owner || result.authentication !== "confirmed") return null;
          return owner.listConversations();
        };
        let result = await list();
        const version = installed?.version;
        if (result?.status !== "available" && await recover(version)) result = await list();
        return result?.status === "available" ? { kind: "conversations", conversations: [...result.conversations] }
          : { kind: "unavailable", reason: qualified ? "identity_unconfirmed" : "qualification_required" };
      },
      async start(accept, onObservation) {
        if (receiverWanted && owner?.state === "receiver-running") {
          await resumeReceiver?.();
          return observation();
        }
        const intent = ++receiverIntent;
        receiverWanted = true;
        receiverRecoveryUsed = false;
        const wanted = () => live() && receiverWanted && receiverIntent === intent;
        const notify = () => { try { if (live()) onObservation?.(observation()); } catch { /* Diagnostics do not own delivery. */ } };
        const spool = new BolterInboxSpool({ directory: directories.spool, scope, cipher: config.cipher, isCurrent: live });
        const startOnce = async (): Promise<boolean> => {
          if (!wanted()) return false;
          const result = await confirmOnce();
          const target = owner;
          if (!target || !wanted() || result.authentication !== "confirmed" || !config.helper) return false;
          let dirty = false;
          let startedEver = false;
          const drain = () => {
            dirty = true;
            if (flush || !wanted() || owner !== target) return;
            let accepted = true;
            const work = (async () => {
              while (dirty && wanted() && owner === target) {
                dirty = false;
                const result = await target.flushInbox((items, receipt) => accept(items.filter(item => item.type === "message"), receipt.id));
                accepted = result === "accepted";
                if (wanted() && owner === target && ingressBlocked !== !accepted) { ingressBlocked = !accepted; notify(); }
                if (!accepted) break;
              }
            })();
            flush = work;
            void work.then(() => {
              if (flush === work) {
                flush = null;
                if (!accepted && wanted() && owner === target && !receiverRecoveryUsed) {
                  receiverRecoveryUsed = true;
                  void recover(installed?.version).then(notify, notify);
                } else if (dirty && accepted && wanted() && owner === target) drain();
              }
            }, () => { if (flush === work) flush = null; });
          };
          const started = await target.startReceiver({ handoverExecutable: config.helper.executable, directory: directories.handover,
            onStateChange: () => {
              if (!wanted() || owner !== target) return;
              notify();
              // A recognized packet proves a successful recovery. A later failure gets its own single attempt.
              if (target.listening) receiverRecoveryUsed = false;
              if (startedEver && target.state === "unavailable" && !receiverRecoveryUsed) {
                receiverRecoveryUsed = true;
                void recover(installed?.version).then(notify, notify);
              }
            },
            spool: { pending: () => spool.pending(), read: id => spool.read(id), acknowledge: receipt => spool.acknowledge(receipt),
              store: async jsonl => { const receipt = await spool.store(jsonl); queueMicrotask(drain); return receipt; } } });
          startedEver = started;
          if (!wanted() || owner !== target) return false;
          if (started) drain();
          return started && target.state === "receiver-running";
        };
        resumeReceiver = startOnce;
        await ensure(owner?.state !== "receiver-running");
        const version = installed?.version;
        if (!await startOnce() && wanted() && !receiverRecoveryUsed) {
          receiverRecoveryUsed = true;
          if (await recover(version, false)) await startOnce();
        }
        return observation();
      },
      async pause() {
        receiverWanted = false; ++receiverIntent; resumeReceiver = null;
        acquisitionController?.abort();
        await owner?.pauseReceiver();
        return observation();
      },
      async prepareSend() {
        await ensure();
        const version = installed?.version;
        if (!owner?.confirmedIdentity) await confirmOnce();
        let prepared = await owner?.prepareSend();
        if (!prepared && await recover(version)) prepared = await owner?.prepareSend();
        // All preparation and recovery precedes the server's release of exact content.
        const sendPrepared = prepared;
        return sendPrepared ? async (content, reauthorize) => {
          const result = await sendPrepared.send({ chatId: content.chatId, threadRootId: content.threadRootId }, content.content, content.files, reauthorize);
          if (result.status !== "sent") {
            // The provider may have accepted this send. Upgrade only future work; never replay content.
            void recover(version).catch(() => undefined);
          }
          return result.status === "sent" ? { kind: "sent", receipt: result.receipt }
            : result.status === "unavailable" ? { kind: "unavailable", reason: "authority_changed" } : { kind: "uncertain" };
        } : null;
      },
      async retire() {
        retired = true; pending = false; receiverWanted = false; ++receiverIntent; ++revision;
        acquisitionController?.abort(); ownerController?.abort();
        await owner?.retire();
        await Promise.allSettled([flush, ensuring, recovering]);
      },
    };
  };
}
