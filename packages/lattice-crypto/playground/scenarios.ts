/**
 * Named, runnable scenarios for the playground. Each builds its own `World`
 * from a given config (matrix row) so you can run any scenario against the
 * dummy group OR real ts-mls. Driven by `runner.ts`.
 */
import {
  World,
  type ReadOutcome,
  type WriteOutcome,
  type WorldConfig,
} from "../src/testing/world.ts";
import { toHex, utf8 } from "../src/util/bytes.ts";
import {
  LATTICE_LIMITS,
  serializeGrant,
  type Grant,
} from "../src/testing/v1-compat.ts";

interface Outcome {
  ok: boolean;
  text?: string;
  reason?: string;
}

function line(label: string, o: Outcome): void {
  const mark = o.ok ? "OK " : "DENY";
  console.log(`  [${mark}] ${label} -> ${(o.ok ? o.text : o.reason) ?? ""}`);
}

type ExpectedOutcome = { ok: true; text?: string } | { ok: false; reason?: string };

function readOutcome(r: ReadOutcome): Outcome {
  return r.ok ? { ok: true, text: r.text } : { ok: false, reason: r.reason };
}

function writeOutcome(w: WriteOutcome): Outcome {
  return w.ok ? { ok: true } : { ok: false, reason: w.reason };
}

function check(
  anom: { n: number },
  label: string,
  outcome: Outcome,
  expected: ExpectedOutcome,
): void {
  line(label, outcome);
  const mismatch =
    outcome.ok !== expected.ok ||
    (expected.ok && expected.text !== undefined && outcome.text !== expected.text) ||
    (!expected.ok && expected.reason !== undefined && outcome.reason !== expected.reason);
  if (mismatch) {
    const expStr = expected.ok
      ? `ok:${expected.text ?? "*"}`
      : `deny:${expected.reason ?? "*"}`;
    const gotStr = outcome.ok ? `ok:${outcome.text ?? "*"}` : `deny:${outcome.reason ?? "*"}`;
    console.log(`  !!!!!!!!!!!!!! UNEXPECTED: expected ${expStr}, got ${gotStr} !!!!!!!!!!!!!!`);
    anom.n++;
  }
}

function bytesContain(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} us`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Raw on-wire byte size of a grant. In the enumeration scheme this is dominated
 * by `encryptedSecret` (the sealed {namespace -> KEK} map) and `coveredEpochs`,
 * BOTH O(#accessible namespaces) — the metric that exposes how v1 scales.
 */
function grantSizeBytes(grant: Grant): number {
  return serializeGrant(grant).length;
}

/** All non-empty subsets of `users` (the full powerset minus the empty set). */
function nonEmptySubsets(users: string[]): string[][] {
  const out: string[][] = [];
  const total = 1 << users.length;
  for (let mask = 1; mask < total; mask++) {
    const subset: string[] = [];
    for (let i = 0; i < users.length; i++) {
      if (mask & (1 << i)) subset.push(users[i]!);
    }
    out.push(subset);
  }
  return out;
}

export interface Scenario {
  description: string;
  run(config: WorldConfig): Promise<void>;
}

export const scenarios: Record<string, Scenario> = {
  basic: {
    description: "subset access: one scope reads every superset namespace",
    async run(config) {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      await w.user("carol");
      const devAlice = await w.device("alice");
      const nsAlice = await w.namespace(["alice"]);
      const nsAB = await w.namespace(["alice", "bob"]);
      const nsABC = await w.namespace(["alice", "bob", "carol"]);
      const nsBob = await w.namespace(["bob"]);
      const oAlice = await w.encrypt(nsAlice, "alice-diary");
      const oAB = await w.encrypt(nsAB, "alice+bob-thread");
      const oABC = await w.encrypt(nsABC, "family-thread");
      const oBob = await w.encrypt(nsBob, "bob-diary");

      console.log("scope {alice}, 2h grant to the agent:");
      const g = await w.grantToAgent(devAlice, ["alice"]);
      line("read {alice}", await w.agentRead(oAlice, g));
      line("read {alice,bob}", await w.agentRead(oAB, g));
      line("read {alice,bob,carol}", await w.agentRead(oABC, g));
      line("read {bob}", await w.agentRead(oBob, g));
    },
  },

  write: {
    description: "agent authors a memory server-side under its grant",
    async run(config) {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devAlice = await w.device("alice");
      const nsAB = await w.namespace(["alice", "bob"]);
      const nsBob = await w.namespace(["bob"]);
      const g = await w.grantToAgent(devAlice, ["alice"]);

      console.log("agent WRITES a new memory under its grant (server-side):");
      const write = await w.agentWrite(nsAB, "agent-authored-memo", g);
      line("write into {alice,bob}", write.ok ? { ok: true, text: "stored" } : { ok: false, reason: write.reason });
      if (write.ok) line("agent reads back its own memory", await w.agentRead(write.id, g));
      const bad = await w.agentWrite(nsBob, "should-fail", g);
      line("write into {bob} (out of scope)", bad.ok ? { ok: true, text: "stored" } : { ok: false, reason: bad.reason });
    },
  },

  membership: {
    description: "removal rotates the epoch and kills grants; expiry denies",
    async run(config) {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devAlice = await w.device("alice");
      const nsAB = await w.namespace(["alice", "bob"]);
      const o = await w.encrypt(nsAB, "before-removal");
      const g = await w.grantToAgent(devAlice, ["alice"], 60 * 60 * 1000);
      line("read before removal", await w.agentRead(o, g));

      console.log("remove bob -> epoch rotates:");
      await w.removeMember(nsAB, "bob");
      line("read with pre-removal grant", await w.agentRead(o, g));

      console.log("advance clock past expiry:");
      w.advanceClock(2 * 60 * 60 * 1000);
      const ns2 = await w.namespace(["alice"]);
      const o2 = await w.encrypt(ns2, "fresh");
      line("read fresh object with expired grant", await w.agentRead(o2, g));
    },
  },

  attacker: {
    description: "attacker's-eye view: dump raw storage (gibberish) + prove no plaintext at rest",
    async run(config) {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice", "bob"]);
      const secret = "TOP-SECRET-MEMO-42";
      const obj = await w.encrypt(ns, secret);

      console.log(`stored the plaintext "${secret}" (encrypted). A DB thief sees:`);
      const snap = w.store.snapshot();
      for (const o of snap.objects) {
        console.log(`  ciphertext ${toHex(o.ciphertext).slice(0, 48)}...`);
        console.log(`  wrappedDEK ${toHex(o.wrappedDek).slice(0, 48)}...`);
      }
      const leaked = snap.objects.some(
        (o) => bytesContain(o.ciphertext, utf8(secret)) || bytesContain(o.wrappedDek, utf8(secret)),
      );
      const anyPrivateKey = snap.devices.some((d) => "privateKey" in d);
      console.log(`  plaintext present anywhere at rest?  ${leaked ? "YES (BUG!)" : "no"}`);
      console.log(`  private keys stored?                 ${anyPrivateKey ? "YES (BUG!)" : "no (public keys only)"}`);

      console.log("decryption only works via a time-bounded grant:");
      const g = await w.grantToAgent(dev, ["alice"]);
      line("agent WITH a valid grant", await w.agentRead(obj, g));
      const impostor = await w.engine.createDelegationSession();
      line("attacker WITHOUT the grant's key", await w.agentRead(obj, { grant: g.grant, session: impostor }));
    },
  },

  multiuser: {
    description: "many users + real membership churn (best with the mls config)",
    async run(config) {
      const w = new World(config);
      for (const u of ["alice", "bob", "carol", "dave"]) await w.user(u);
      const devAlice = await w.device("alice");
      const family = await w.namespace(["alice", "bob", "carol"]);
      const pair = await w.namespace(["alice", "bob"]);
      const oFamily = await w.encrypt(family, "family-note");
      const oPair = await w.encrypt(pair, "alice+bob-note");

      console.log("agent grant for scope {alice} covers every room alice is in:");
      const g = await w.grantToAgent(devAlice, ["alice"]);
      line("read family {a,b,c}", await w.agentRead(oFamily, g));
      line("read pair {a,b}", await w.agentRead(oPair, g));

      console.log("add newly invited dave to family (MLS commit + lattice epoch rotation):");
      await w.addMember(family, "dave");
      line("old grant is void on family", await w.agentRead(oFamily, g));
      line("pair grant remains valid (untouched)", await w.agentRead(oPair, g));

      console.log("remove carol from family (real MLS commit -> epoch rotates):");
      await w.removeMember(family, "carol");
      line("agent read family with pre-removal grant", await w.agentRead(oFamily, g));
      line("pair room grant still valid (untouched)", await w.agentRead(oPair, g));
    },
  },

  lifecycle: {
    description:
      "full lifecycle: multi-namespace grants, agent writes, add/remove churn, expiry, single-use, revocation, op-scoping",
    async run(config) {
      const anom = { n: 0 };
      let checks = 0;
      const expect = (
        label: string,
        outcome: Outcome,
        expected: ExpectedOutcome,
      ): void => {
        checks++;
        check(anom, label, outcome, expected);
      };

      const w = new World(config);
      for (const u of ["alice", "bob", "carol", "dave"]) await w.user(u);
      const devAlice = await w.device("alice");

      console.log("setup: namespaces, objects, and a bob-only room:");
      const solo = await w.namespace(["alice"]);
      const pair = await w.namespace(["alice", "bob"]);
      const family = await w.namespace(["alice", "bob", "carol"]);
      const nsBob = await w.namespace(["bob"]);
      const diary = await w.encrypt(solo, "alice-diary");
      const thread = await w.encrypt(pair, "alice+bob-thread");
      const note = await w.encrypt(family, "family-note");
      const bobOnly = await w.encrypt(nsBob, "bob-only");

      console.log("G1 scope {alice} — default read+write across alice's rooms:");
      const g1 = await w.grantToAgent(devAlice, ["alice"]);
      expect("G1 read diary {alice}", readOutcome(await w.agentRead(diary, g1)), {
        ok: true,
        text: "alice-diary",
      });
      expect("G1 read thread {alice,bob}", readOutcome(await w.agentRead(thread, g1)), {
        ok: true,
        text: "alice+bob-thread",
      });
      expect("G1 read note {alice,bob,carol}", readOutcome(await w.agentRead(note, g1)), {
        ok: true,
        text: "family-note",
      });
      expect("G1 read bob-only {bob}", readOutcome(await w.agentRead(bobOnly, g1)), {
        ok: false,
        reason: "out_of_scope",
      });
      const memoWrite = await w.agentWrite(family, "agent-memo", g1);
      expect("G1 write memo into family", writeOutcome(memoWrite), { ok: true });
      if (memoWrite.ok) {
        expect(
          "G1 read back agent memo",
          readOutcome(await w.agentRead(memoWrite.id, g1)),
          { ok: true, text: "agent-memo" },
        );
      } else {
        checks++;
        check(anom, "G1 read back agent memo", { ok: false, reason: "skipped" }, {
          ok: true,
          text: "agent-memo",
        });
      }
      expect(
        "G1 write into bob-only {bob}",
        writeOutcome(await w.agentWrite(nsBob, "nope", g1)),
        { ok: false, reason: "out_of_scope" },
      );

      console.log("add newly invited dave to family (epoch rotates):");
      await w.addMember(family, "dave");
      expect(
        "G1 read family note after addMember",
        readOutcome(await w.agentRead(note, g1)),
        { ok: false, reason: "epoch_rotated" },
      );

      console.log("remove carol from family (epoch rotates):");
      await w.removeMember(family, "carol");
      expect(
        "G1 read family note after removal",
        readOutcome(await w.agentRead(note, g1)),
        { ok: false, reason: "epoch_rotated" },
      );
      expect(
        "G1 write into family after removal",
        writeOutcome(await w.agentWrite(family, "stale", g1)),
        { ok: false, reason: "epoch_rotated" },
      );
      expect(
        "G1 read pair thread (untouched namespace)",
        readOutcome(await w.agentRead(thread, g1)),
        { ok: true, text: "alice+bob-thread" },
      );

      console.log("re-mint G2 after rotation; fresh object at new epoch:");
      const g2 = await w.grantToAgent(devAlice, ["alice"]);
      const freshNote = await w.encrypt(family, "fresh-note");
      expect(
        "G2 read fresh family note",
        readOutcome(await w.agentRead(freshNote, g2)),
        { ok: true, text: "fresh-note" },
      );
      expect(
        "G2 read pre-rotation family note",
        readOutcome(await w.agentRead(note, g2)),
        { ok: false, reason: "epoch_mismatch" },
      );

      console.log("re-mint G2-history with explicit retained epoch 0:");
      const historySession = await w.engine.createDelegationSession();
      const historyGrant = await w.engine.mintGrant({
        issuer: w.deviceCapability(devAlice),
        scope: ["alice"],
        recipientPublicKey: historySession.keyPair.publicKey,
        ttlMs: 2 * 60 * 60 * 1000,
        historicalEpochs: { [family]: [0] },
      });
      const history = { grant: historyGrant, session: historySession };
      expect(
        "G2-history read pre-rotation family note",
        readOutcome(await w.agentRead(note, history)),
        { ok: true, text: "family-note" },
      );
      expect(
        "G2-history read current family note",
        readOutcome(await w.agentRead(freshNote, history)),
        { ok: true, text: "fresh-note" },
      );

      console.log("expiry boundary (G3 ttl=1000ms):");
      const g3 = await w.grantToAgent(devAlice, ["alice"], 1_000);
      const objE = await w.encrypt(solo, "expiry-obj");
      w.advanceClock(1_000);
      expect(
        "G3 read expiry-obj at boundary (still valid)",
        readOutcome(await w.agentRead(objE, g3)),
        { ok: true, text: "expiry-obj" },
      );
      w.advanceClock(1);
      expect(
        "G3 read expiry-obj after boundary (+1ms)",
        readOutcome(await w.agentRead(objE, g3)),
        { ok: false, reason: "grant_expired" },
      );

      console.log("single-use grant G4:");
      const g4 = await w.grantToAgent(devAlice, ["alice"], 2 * 60 * 60 * 1000, true);
      expect("G4 first read diary", readOutcome(await w.agentRead(diary, g4)), {
        ok: true,
        text: "alice-diary",
      });
      expect("G4 second read diary", readOutcome(await w.agentRead(diary, g4)), {
        ok: false,
        reason: "grant_consumed",
      });

      console.log("operation scoping (read-only vs write-only grants):");
      const ro = await w.grantToAgent(devAlice, ["alice"], 2 * 60 * 60 * 1000, false, [
        "decrypt",
      ]);
      expect("RO read diary", readOutcome(await w.agentRead(diary, ro)), {
        ok: true,
        text: "alice-diary",
      });
      expect(
        "RO write into pair",
        writeOutcome(await w.agentWrite(pair, "ro-blocked", ro)),
        { ok: false, reason: "operation_not_permitted" },
      );
      const wo = await w.grantToAgent(devAlice, ["alice"], 2 * 60 * 60 * 1000, false, [
        "encrypt",
      ]);
      expect(
        "WO write into pair",
        writeOutcome(await w.agentWrite(pair, "wo-memo", wo)),
        { ok: true },
      );
      expect("WO read diary", readOutcome(await w.agentRead(diary, wo)), {
        ok: false,
        reason: "operation_not_permitted",
      });

      console.log("revoke issuing device (G2 should fail closed):");
      await w.engine.revokeDevice(devAlice);
      expect(
        "G2 read diary after device revocation",
        readOutcome(await w.agentRead(diary, g2)),
        { ok: false, reason: "grant_device_revoked" },
      );

      if (anom.n === 0) {
        console.log(`  lifecycle: all ${checks} checks matched expectations`);
      } else {
        console.log(
          `  !!!!!!!!!!!!!! LIFECYCLE FAILED: ${anom.n}/${checks} checks UNEXPECTED !!!!!!!!!!!!!!`,
        );
      }
    },
  },

  recovery: {
    description:
      "pending-device authorization + offline history recovery + live current-root catch-up",
    async run(config) {
      const anom = { n: 0 };
      const w = new World(config);
      const alice = await w.device("alice");
      await w.device("bob");
      const room = await w.namespace(["alice", "bob"]);
      const oldObject = await w.encrypt(room, "pre-loss history", alice);
      const kit = await w.engine.createRecoveryKit();
      const archive = await w.engine.createRecoveryArchive(
        w.deviceCapability(alice),
        kit,
        1,
      );

      console.log("lose/revoke alice's only device; bob advances the room:");
      await w.engine.revokeDevice(alice);
      const pending = await w.engine.registerDevice("alice");
      console.log(`  pending device authorized by login? ${pending.device.authorized}`);

      console.log("open offline archive, join a fresh leaf, catch up current root from bob:");
      await w.engine.recoverDevice(
        pending.device.id,
        pending.encryptionPrivateKey,
        kit,
        archive,
      );
      const session = await w.engine.createDelegationSession();
      const grant = await w.engine.mintGrant({
        issuer: pending.capability,
        scope: ["alice"],
        recipientPublicKey: session.keyPair.publicKey,
        ttlMs: 60_000,
        historicalEpochs: { [room]: [0] },
      });
      const recovered = { grant, session };
      check(
        anom,
        "recovered device delegates pre-loss history",
        readOutcome(await w.agentRead(oldObject, recovered)),
        { ok: true, text: "pre-loss history" },
      );
      const currentObject = (
        await w.engine.encryptObject(
          room,
          utf8("post-recovery current"),
          pending.capability,
        )
      ).id;
      check(
        anom,
        "recovered device reads current epoch",
        readOutcome(await w.agentRead(currentObject, recovered)),
        { ok: true, text: "post-recovery current" },
      );
      console.log(
        anom.n === 0
          ? "  recovery: all checks matched expectations"
          : `  !!!!!!!!!!!!!! RECOVERY FAILED: ${anom.n} unexpected !!!!!!!!!!!!!!`,
      );
    },
  },

  batch: {
    description:
      "batch read/write: ONE grant verify+open serves many objects (decryptMany / encryptMany)",
    async run(config) {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      await w.user("carol");
      const devAlice = await w.device("alice");
      const nsAlice = await w.namespace(["alice"]);
      const nsAB = await w.namespace(["alice", "bob"]);
      const nsABC = await w.namespace(["alice", "bob", "carol"]);
      const nsBob = await w.namespace(["bob"]);

      // A spread of objects: three the {alice} scope can reach, one it cannot.
      const oAlice = await w.encrypt(nsAlice, "alice-diary");
      const oAB = await w.encrypt(nsAB, "alice+bob-thread");
      const oABC = await w.encrypt(nsABC, "family-thread");
      const oBob = await w.encrypt(nsBob, "bob-diary");

      const g = await w.grantToAgent(devAlice, ["alice"]);

      console.log(
        "decryptMany over 5 ids (3 in-scope, 1 out-of-scope, 1 missing) — ONE verify + open, results aligned 1:1:",
      );
      const readIds = [oAlice, oAB, oABC, oBob, "obj_missing"];
      const readLabels = [
        "read {alice}",
        "read {alice,bob}",
        "read {alice,bob,carol}",
        "read {bob} (out of scope)",
        "read missing id",
      ];
      const reads = await w.agentReadMany(readIds, g);
      reads.forEach((r, i) => line(readLabels[i]!, readOutcome(r)));

      console.log(
        "\nencryptMany authors 3 memories server-side (2 in-scope, 1 out-of-scope) — ONE verify + open:",
      );
      const writeItems = [
        { namespaceId: nsAlice, text: "memo-solo" },
        { namespaceId: nsABC, text: "memo-family" },
        { namespaceId: nsBob, text: "memo-should-fail" },
      ];
      const writeLabels = [
        "write {alice}",
        "write {alice,bob,carol}",
        "write {bob} (out of scope)",
      ];
      const writes = await w.agentWriteMany(writeItems, g);
      writes.forEach((wr, i) => line(writeLabels[i]!, writeOutcome(wr)));

      console.log("\nbatch read-back of the freshly written memories:");
      const writtenIds: string[] = [];
      for (const wr of writes) if (wr.ok) writtenIds.push(wr.id);
      const readback = await w.agentReadMany(writtenIds, g);
      readback.forEach((r, i) => line(`read written #${i + 1}`, readOutcome(r)));

      console.log(
        "\nsingle-use grant: ONE decryptMany covers the whole batch; a SECOND batch is denied:",
      );
      const su = await w.grantToAgent(devAlice, ["alice"], 60 * 60 * 1000, true);
      const firstBatch = await w.agentReadMany([oAlice, oAB, oABC], su);
      firstBatch.forEach((r, i) => line(`1st batch read #${i + 1}`, readOutcome(r)));
      const secondBatch = await w.agentReadMany([oAlice, oAB], su);
      secondBatch.forEach((r, i) => line(`2nd batch read #${i + 1}`, readOutcome(r)));
    },
  },

  scaling: {
    description:
      "enumeration scaling: grant size + full-access time vs N users over ALL namespaces (powerset)",
    async run(config) {
      const isMls = config.name.includes("mls");
      // Materializing every namespace costs 2^N - 1 group inits. A real MLS
      // group is far more expensive to spin up than the dummy, and the in-memory
      // store's namespace dedup is O(n) per insert (so setup is O(namespaces^2));
      // both cap how large N can go per row. OpenMLS is much faster than ts-mls,
      // so override the cap with LATTICE_SCALING_BUDGET to push N higher.
      const budgetEnv = Number.parseInt(process.env["LATTICE_SCALING_BUDGET"] ?? "", 10);
      const budget = Number.isInteger(budgetEnv) && budgetEnv > 0 ? budgetEnv : isMls ? 1023 : 10_000;
      const explicit = process.argv.includes("scaling");
      const envNs = process.env["LATTICE_SCALING_NS"];
      // Defaults are conservative so `bun run play <config> scaling` stays quick;
      // push higher deliberately via LATTICE_SCALING_NS (mls N=10 ≈ 12 min).
      const defaultNs = isMls ? [5] : [5, 10, 13];
      const nList = envNs
        ? envNs
            .split(",")
            .map((s) => Number.parseInt(s.trim(), 10))
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= 22)
        : explicit
          ? defaultNs
          : [5];

      if (!explicit && !envNs) {
        console.log(
          `  quick default N=5. Full sweep: \`bun run play ${config.name} scaling\`` +
            ` or set LATTICE_SCALING_NS=5,10,13`,
        );
      }
      console.log(`  row=${config.name}  materialization budget=${budget} namespaces\n`);

      for (const N of nList) {
        const totalNs = 2 ** N - 1;
        if (totalNs > budget) {
          console.log(
            `  N=${N}: SKIP — would materialize ${totalNs} namespaces (> budget ${budget})`,
          );
          continue;
        }

        const w = new World(config);
        const users = Array.from({ length: N }, (_, i) => `u${i}`);
        for (const u of users) await w.user(u);
        const dev = await w.device(users[0]!);

        const subsets = nonEmptySubsets(users);
        const objByNs = new Map<string, string>();
        const buildStart = performance.now();
        for (const subset of subsets) {
          const nsId = await w.namespace(subset);
          objByNs.set(nsId, await w.encrypt(nsId, `data-${nsId}`));
        }
        const buildMs = performance.now() - buildStart;
        console.log(
          `  N=${N}: built ${subsets.length} namespaces (+1 object each) in ${fmtDuration(buildMs)}`,
        );

        const scopes: { label: string; scope: string[] }[] = [
          { label: "single", scope: [users[0]!] },
          { label: "half", scope: users.slice(0, Math.ceil(N / 2)) },
          { label: "all", scope: [...users] },
        ];

        for (const { label, scope } of scopes) {
          const expectedCovered = subsets.filter((participants) =>
            scope.every((userId) => participants.includes(userId))
          ).length;
          if (expectedCovered > LATTICE_LIMITS.coveredNamespaces) {
            console.log(
              `    scope=${label.padEnd(6)} |scope|=${String(scope.length).padStart(2)}` +
                `  covered=${String(expectedCovered).padStart(6)}` +
                `  REJECTED by ${LATTICE_LIMITS.coveredNamespaces}-namespace grant limit`,
            );
            continue;
          }
          const mintStart = performance.now();
          const g = await w.grantToAgent(dev, scope);
          const mintMs = performance.now() - mintStart;

          const covered = Object.keys(g.grant.coveredEpochs);
          const size = grantSizeBytes(g.grant);

          // A full access sweep re-opens the sealed KEK map once PER object, so
          // it is ~O(covered^2). Past a cap we time a sample and extrapolate the
          // total (grant size + mint stay exact/full).
          const ACCESS_SAMPLE = 500;
          const sampled = covered.length > ACCESS_SAMPLE;
          const toRead = sampled ? covered.slice(0, ACCESS_SAMPLE) : covered;
          let ok = 0;
          let fail = 0;
          const accessStart = performance.now();
          for (const nsId of toRead) {
            const objId = objByNs.get(nsId);
            if (!objId) {
              fail++;
              continue;
            }
            const r = await w.agentRead(objId, g);
            if (r.ok) ok++;
            else fail++;
          }
          const sweepMs = performance.now() - accessStart;
          const perNs = toRead.length > 0 ? sweepMs / toRead.length : 0;
          const accessLabel = sampled
            ? `~${fmtDuration(perNs * covered.length)} (sampled ${ACCESS_SAMPLE}/${covered.length})`
            : fmtDuration(sweepMs);

          console.log(
            `    scope=${label.padEnd(6)} |scope|=${String(scope.length).padStart(2)}` +
              `  covered=${String(covered.length).padStart(6)}` +
              `  grant=${fmtBytes(size).padStart(10)}` +
              `  mint=${fmtDuration(mintMs).padStart(9)}` +
              `  access-all=${accessLabel.padStart(9)}` +
              `  per-ns=${fmtDuration(perNs).padStart(8)}` +
              `  reads=${ok}ok${fail ? `/${fail}FAIL` : ""}`,
          );

          // Batch path: verify + open the grant ONCE, then decrypt every covered
          // object in a single decryptMany call. A FRESH grant is used so the
          // session cache starts cold — this times one verify + one open + N
          // in-memory AEAD opens (the intended production read pattern).
          const gBatch = await w.grantToAgent(dev, scope);
          const batchIds = covered
            .map((nsId) => objByNs.get(nsId))
            .filter((x): x is string => x !== undefined);
          const batchStart = performance.now();
          const batchOut = await w.agentReadMany(batchIds, gBatch);
          const batchMs = performance.now() - batchStart;
          const batchOk = batchOut.filter((r) => r.ok).length;
          const batchFail = batchOut.length - batchOk;
          const batchPerNs = batchIds.length > 0 ? batchMs / batchIds.length : 0;
          console.log(
            `           ${" ".repeat(label.length)}batch-all=${fmtDuration(batchMs).padStart(9)}` +
              `  per-ns=${fmtDuration(batchPerNs).padStart(8)}` +
              `  reads=${batchOk}ok${batchFail ? `/${batchFail}FAIL` : ""}  (decryptMany, cold cache, 1 open)`,
          );
        }
        console.log("");
      }
    },
  },
};
