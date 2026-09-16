import { describe, expect, test } from "bun:test";
import { LatticeCrypto, manualClock, seededRng } from "../../src/crypto/index.ts";
import { LatticeCryptoEngine } from "../../src/engine/engine.ts";
import { matrix } from "../../src/testing/matrix.ts";
import { InMemoryRelationalStore } from "../../src/storage/in-memory-relational-store.ts";
import type { Storage } from "../../src/storage/store.ts";
import { utf8 } from "../../src/util/bytes.ts";

/**
 * Force every storage operation across a real asynchronous boundary. The cast
 * used by the original red reproduction is no longer needed: this typed wrapper
 * now proves every Storage method really is promise-based. An engine that
 * forgets any `await` observes a Promise where it expected a row/list or reports
 * success before a rejected write settles.
 */
class DelayedStorage implements Storage {
  readonly backing = new InMemoryRelationalStore();
  private nextObjectWriteFailure: string | null = null;
  private nextPostCommitClaimFailure: string | null = null;
  claimAttempts = 0;

  failNextObjectWrite(message: string): void {
    this.nextObjectWriteFailure = message;
  }

  failNextClaimAfterCommit(message: string): void {
    this.nextPostCommitClaimFailure = message;
  }

  private async delay<T>(operation: () => Promise<T>): Promise<T> {
    await Promise.resolve();
    return operation();
  }

  putUser(...args: Parameters<Storage["putUser"]>): ReturnType<Storage["putUser"]> {
    return this.delay(() => this.backing.putUser(...args));
  }
  listUsers(...args: Parameters<Storage["listUsers"]>): ReturnType<Storage["listUsers"]> {
    return this.delay(() => this.backing.listUsers(...args));
  }
  putDevice(...args: Parameters<Storage["putDevice"]>): ReturnType<Storage["putDevice"]> {
    return this.delay(() => this.backing.putDevice(...args));
  }
  getDevice(...args: Parameters<Storage["getDevice"]>): ReturnType<Storage["getDevice"]> {
    return this.delay(() => this.backing.getDevice(...args));
  }
  listDevices(
    ...args: Parameters<Storage["listDevices"]>
  ): ReturnType<Storage["listDevices"]> {
    return this.delay(() => this.backing.listDevices(...args));
  }
  authorizeDevice(
    ...args: Parameters<Storage["authorizeDevice"]>
  ): ReturnType<Storage["authorizeDevice"]> {
    return this.delay(() => this.backing.authorizeDevice(...args));
  }
  revokeDevice(
    ...args: Parameters<Storage["revokeDevice"]>
  ): ReturnType<Storage["revokeDevice"]> {
    return this.delay(() => this.backing.revokeDevice(...args));
  }
  putNamespace(
    ...args: Parameters<Storage["putNamespace"]>
  ): ReturnType<Storage["putNamespace"]> {
    return this.delay(() => this.backing.putNamespace(...args));
  }
  getNamespace(
    ...args: Parameters<Storage["getNamespace"]>
  ): ReturnType<Storage["getNamespace"]> {
    return this.delay(() => this.backing.getNamespace(...args));
  }
  findNamespaceByParticipants(
    ...args: Parameters<Storage["findNamespaceByParticipants"]>
  ): ReturnType<Storage["findNamespaceByParticipants"]> {
    return this.delay(() => this.backing.findNamespaceByParticipants(...args));
  }
  listNamespaces(
    ...args: Parameters<Storage["listNamespaces"]>
  ): ReturnType<Storage["listNamespaces"]> {
    return this.delay(() => this.backing.listNamespaces(...args));
  }
  findNamespacesContainingSubset(
    ...args: Parameters<Storage["findNamespacesContainingSubset"]>
  ): ReturnType<Storage["findNamespacesContainingSubset"]> {
    return this.delay(() => this.backing.findNamespacesContainingSubset(...args));
  }
  updateNamespace(
    ...args: Parameters<Storage["updateNamespace"]>
  ): ReturnType<Storage["updateNamespace"]> {
    return this.delay(() => this.backing.updateNamespace(...args));
  }
  putObject(...args: Parameters<Storage["putObject"]>): ReturnType<Storage["putObject"]> {
    return this.delay(async () => {
      if (this.nextObjectWriteFailure !== null) {
        const message = this.nextObjectWriteFailure;
        this.nextObjectWriteFailure = null;
        throw new Error(message);
      }
      await this.backing.putObject(...args);
    });
  }
  getObject(...args: Parameters<Storage["getObject"]>): ReturnType<Storage["getObject"]> {
    return this.delay(() => this.backing.getObject(...args));
  }
  getObjects(...args: Parameters<Storage["getObjects"]>): ReturnType<Storage["getObjects"]> {
    return this.delay(() => this.backing.getObjects(...args));
  }
  listObjectsInNamespace(
    ...args: Parameters<Storage["listObjectsInNamespace"]>
  ): ReturnType<Storage["listObjectsInNamespace"]> {
    return this.delay(() => this.backing.listObjectsInNamespace(...args));
  }
  putGrant(...args: Parameters<Storage["putGrant"]>): ReturnType<Storage["putGrant"]> {
    return this.delay(() => this.backing.putGrant(...args));
  }
  getGrant(...args: Parameters<Storage["getGrant"]>): ReturnType<Storage["getGrant"]> {
    return this.delay(() => this.backing.getGrant(...args));
  }
  consumeGrant(
    ...args: Parameters<Storage["consumeGrant"]>
  ): ReturnType<Storage["consumeGrant"]> {
    return this.delay(async () => {
      this.claimAttempts++;
      const result = await this.backing.consumeGrant(...args);
      if (this.nextPostCommitClaimFailure !== null) {
        const message = this.nextPostCommitClaimFailure;
        this.nextPostCommitClaimFailure = null;
        throw new Error(message);
      }
      return result;
    });
  }
  appendAudit(
    ...args: Parameters<Storage["appendAudit"]>
  ): ReturnType<Storage["appendAudit"]> {
    return this.delay(() => this.backing.appendAudit(...args));
  }
  auditLog(...args: Parameters<Storage["auditLog"]>): ReturnType<Storage["auditLog"]> {
    return this.delay(() => this.backing.auditLog(...args));
  }
}

function asyncStorageHarness(): DelayedStorage {
  return new DelayedStorage();
}

for (const config of matrix) {
  describe(`async storage contract: ${config.name}`, () => {
    test("a complete workflow waits for every delayed storage operation", async () => {
      const harness = asyncStorageHarness();
      const clock = manualClock(1_000);
      const crypto = new LatticeCrypto(seededRng(101), clock);
      const engine = new LatticeCryptoEngine({
        storage: harness,
        scheme: config.makeScheme(),
        group: config.makeGroup(crypto),
        crypto,
      });

      await engine.registerUser("alice");
      const registration = await engine.registerDevice("alice");
      const namespace = await engine.findOrCreateNamespace(["alice"]);
      const object = await engine.encryptObject(
        namespace.id,
        utf8("delayed-storage"),
        registration.capability,
      );
      const session = await engine.createDelegationSession();
      const grant = await engine.mintGrant({
        issuer: registration.capability,
        scope: ["alice"],
        recipientPublicKey: session.keyPair.publicKey,
        ttlMs: 60_000,
      });

      const result = await engine.decryptObject(object.id, grant, session);
      expect(result.ok).toBe(true);
      expect(await engine.objectExists(object.id)).toBe(true);
      expect((await harness.backing.getObject(object.id))?.id).toBe(object.id);
    });

    test("a rejected post-claim write is observed and the grant stays consumed", async () => {
      const harness = asyncStorageHarness();
      const clock = manualClock(1_000);
      const crypto = new LatticeCrypto(seededRng(102), clock);
      const engine = new LatticeCryptoEngine({
        storage: harness,
        scheme: config.makeScheme(),
        group: config.makeGroup(crypto),
        crypto,
      });

      const registration = await engine.registerDevice("alice");
      const namespace = await engine.findOrCreateNamespace(["alice"]);
      const session = await engine.createDelegationSession();
      const grant = await engine.mintGrant({
        issuer: registration.capability,
        scope: ["alice"],
        recipientPublicKey: session.keyPair.publicKey,
        ttlMs: 60_000,
        singleUse: true,
        operations: ["encrypt"],
      });

      harness.failNextObjectWrite("simulated async object write failure");
      expect(
        engine.encryptWithGrant(namespace.id, utf8("must-not-commit"), grant, session),
      ).rejects.toThrow("simulated async object write failure");

      expect(
        await engine.encryptWithGrant(
          namespace.id,
          utf8("must-not-retry"),
          grant,
          session,
        ),
      ).toEqual({ ok: false, reason: "grant_consumed" });
      expect((await harness.backing.getGrant(grant.id))?.consumed).toBe(true);
    });

    test("concurrent asynchronous claims have exactly one winner", async () => {
      const harness = asyncStorageHarness();
      const clock = manualClock(1_000);
      const crypto = new LatticeCrypto(seededRng(103), clock);
      const engine = new LatticeCryptoEngine({
        storage: harness,
        scheme: config.makeScheme(),
        group: config.makeGroup(crypto),
        crypto,
      });

      const registration = await engine.registerDevice("alice");
      await engine.findOrCreateNamespace(["alice"]);
      const session = await engine.createDelegationSession();
      const grant = await engine.mintGrant({
        issuer: registration.capability,
        scope: ["alice"],
        recipientPublicKey: session.keyPair.publicKey,
        ttlMs: 60_000,
        singleUse: true,
      });

      const claims = await Promise.all([
        engine.consumeGrant(grant.id),
        engine.consumeGrant(grant.id),
      ]);
      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
      expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    });

    test("an ambiguous post-commit claim error is never automatically retried", async () => {
      const harness = asyncStorageHarness();
      const clock = manualClock(1_000);
      const crypto = new LatticeCrypto(seededRng(104), clock);
      const engine = new LatticeCryptoEngine({
        storage: harness,
        scheme: config.makeScheme(),
        group: config.makeGroup(crypto),
        crypto,
      });

      const registration = await engine.registerDevice("alice");
      const namespace = await engine.findOrCreateNamespace(["alice"]);
      const session = await engine.createDelegationSession();
      const grant = await engine.mintGrant({
        issuer: registration.capability,
        scope: ["alice"],
        recipientPublicKey: session.keyPair.publicKey,
        ttlMs: 60_000,
        singleUse: true,
        operations: ["encrypt"],
      });

      harness.failNextClaimAfterCommit("simulated lost claim acknowledgement");
      expect(
        engine.encryptWithGrant(namespace.id, utf8("ambiguous"), grant, session),
      ).rejects.toThrow("simulated lost claim acknowledgement");
      expect(harness.claimAttempts).toBe(1);

      expect(
        await engine.encryptWithGrant(
          namespace.id,
          utf8("explicit-retry"),
          grant,
          session,
        ),
      ).toEqual({ ok: false, reason: "grant_consumed" });
      expect(harness.claimAttempts).toBe(1);
    });
  });
}
