import { describe, expect, spyOn, test } from "bun:test";
import {
  LatticeCrypto,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  prepareAgentRuntimeInitialization,
  verifyHistoricalAgentRuntimeSignerPublication,
} from "@nautilo/lattice-crypto";
import {
  agentRuntimeDomainEnvelopeSigningBytesV1,
  parseAgentRuntimeDomainEnvelopeV1,
} from "@nautilo/lattice-crypto/wire";
import {
  PostgresLatticeStorage,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "@nautilo/lattice-bridge/server";
import {
  withProtectedTaskResultSignerHistory,
  type ProtectedTaskResultSignerHistory,
} from "../../src/routes/protected-task-result-signer-history";

type Row = Awaited<ReturnType<CryptoPostgresExecutor["query"]>>[number];
const AGENT = "task-result-history-agent";
const DOMAIN = "task-result-history-domain";
const COMMITTER = "task-result-history-committer";
const MANAGER = "task-result-history-manager";
const HUMAN = "task-result-history-human";
type Adjust = (stage: string, rows: Row[]) => Row[];

async function fixture(adjust: Adjust = (_stage, rows) => rows) {
  const crypto = new LatticeCrypto();
  const committer = crypto.generateSigningKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const prepared = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "task-result-history-init",
    agentId: agentId(AGENT),
    authorizationRevision: authorizationRevision(7),
    configObjects: [
      {
        objectId: "task-result-history-config",
        configRevision: authorizationRevision(1),
        plaintextDek: new Uint8Array(32).fill(3),
      },
    ],
    domains: [
      {
        domainId: cryptoDomainId(DOMAIN),
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision: authorizationRevision(7),
        committerDeviceId: cryptoDeviceId(COMMITTER),
        domainRoot: new Uint8Array(32).fill(4),
        committerSigningPrivateKey: committer.privateKey,
      },
    ],
    resolveCurrentDomainCommitterAuthority: () => committer.publicKey,
    manager: {
      managerHumanId: humanId(HUMAN),
      managerAuthorizationRevision: authorizationRevision(3),
      managerDeviceId: cryptoDeviceId(MANAGER),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  prepared.runtime.key.fill(0);
  const intended = prepared.intended;
  const calls: string[] = [];
  const query: CryptoPostgresExecutor["query"] = async <Result extends Row>(
    statement: string,
  ) => {
    let stage: string;
    let rows: Row[];
    if (statement.includes("current_user::text")) {
      stage = "role";
      rows = [
        { current_user: "nautilo_crypto", session_user: "nautilo_crypto" },
      ];
    } else if (statement.includes('from "human_crypto_devices"')) {
      stage = "devices";
      rows = [
        {
          device_id: COMMITTER,
          human_id: "committer-human",
          state: "active",
          revision: 2,
          signing_public_key: committer.publicKey,
        },
        {
          device_id: MANAGER,
          human_id: HUMAN,
          state: "active",
          revision: 3,
          signing_public_key: manager.publicKey,
        },
      ];
    } else if (statement.includes('from "agent_crypto_runtime_states"')) {
      stage = "state";
      rows = [
        {
          agent_id: AGENT,
          authorization_revision: 7,
          runtime_generation: 0,
          config_object_count: intended.configInventory.objectCount,
          config_inventory_digest: intended.configInventory.digest,
        },
      ];
    } else if (
      statement.includes('from "agent_crypto_runtime_config_objects"')
    ) {
      stage = "config";
      rows = intended.configObjects.map((entry) => ({
        agent_id: entry.agentId,
        object_id: entry.objectId,
        config_revision: entry.configRevision,
        runtime_generation: entry.runtimeGeneration,
        wrapped_dek_hash: entry.wrappedDekHash,
        wrapped_dek_bytes: entry.wrappedDek.ciphertext,
      }));
    } else if (
      statement.includes('from "agent_crypto_runtime_domain_envelopes"')
    ) {
      stage = "envelope";
      rows = intended.domainEnvelopes.map((entry) => ({
        agent_id: entry.agentId,
        domain_id: entry.domainId,
        domain_epoch: entry.domainEpoch,
        agent_authorization_revision: entry.agentAuthorizationRevision,
        runtime_generation: entry.runtimeGeneration,
        committer_device_id: entry.committerDeviceId,
        envelope_hash: entry.envelopeHash,
        envelope_bytes: entry.envelopeBytes.ciphertext,
      }));
    } else if (statement.includes('from "agent_crypto_runtime_challenges"')) {
      stage = "challenges";
      rows = [];
    } else throw new Error(`Unexpected signer history query: ${statement}`);
    calls.push(stage);
    return adjust(stage, rows).map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          value instanceof Uint8Array ? value.slice() : value,
        ]),
      ),
    ) as Result[];
  };
  const connection: CryptoPostgresConnection = {
    query,
    transaction: async (use) => use({ query }),
  };
  const handle = await verifyCryptoPostgresHandle(connection);
  const publication = spyOn(
    PostgresLatticeStorage.prototype,
    "getAgentRuntimeSignerPublication",
  ).mockImplementation(async () => structuredClone(prepared.signerPublication));
  const envelope = parseAgentRuntimeDomainEnvelopeV1(
    intended.domainEnvelopes[0]!.envelopeBytes.ciphertext,
  );
  const committerContext = {
    purpose: "agent-runtime-domain-envelope" as const,
    agentId: envelope.agentId,
    domainId: envelope.domainId,
    domainEpoch: envelope.domainEpoch,
    agentAuthorizationRevision: envelope.agentAuthorizationRevision,
    runtimeGeneration: envelope.runtimeGeneration,
    committerDeviceId: envelope.committerDeviceId,
  };
  const { signature: _signature, ...unsignedPublication } =
    prepared.signerPublication;
  const managerContext = {
    purpose: "verify-historical-agent-runtime-signer-publication" as const,
    ...unsignedPublication,
  };
  const input = {
    handle,
    crypto,
    agentId: AGENT,
    domainId: DOMAIN,
    domainEpoch: 4,
    expectedAgentAuthorizationRevision: 7,
    expectedRuntimeGeneration: 0,
  };
  return {
    input,
    calls,
    publication,
    prepared,
    envelope,
    committerContext,
    managerContext,
  };
}
async function fails(operation: Promise<unknown>): Promise<void> {
  expect(
    await operation.then(
      () => null,
      (error: unknown) => error,
    ),
  ).toBeInstanceOf(Error);
}

describe("protected Task result signer history", () => {
  test("preloads only the exact signed contexts and wipes keys after use", async () => {
    const value = await fixture();
    let escaped: ProtectedTaskResultSignerHistory | undefined;
    const borrowed: Uint8Array[] = [];
    try {
      expect(
        await withProtectedTaskResultSignerHistory({
          ...value.input,
          use: (history) => {
            escaped = history;
            const committer = history.resolveHistoricalRuntimeCommitter(
              value.committerContext,
            );
            const manager = history.resolveHistoricalSignerPublicationManager(
              value.managerContext,
            );
            expect(committer).not.toBeNull();
            expect(manager).not.toBeNull();
            borrowed.push(committer!, manager!);
            expect(
              value.input.crypto.verify(
                committer!,
                agentRuntimeDomainEnvelopeSigningBytesV1(value.envelope),
                value.envelope.signature,
              ),
            ).toBe(true);
            expect(
              verifyHistoricalAgentRuntimeSignerPublication({
                crypto: value.input.crypto,
                publication: value.prepared.signerPublication,
                resolveHistoricalManagerAuthority:
                  history.resolveHistoricalSignerPublicationManager,
              }),
            ).toBe(true);
            expect(
              history.resolveHistoricalRuntimeCommitter({
                ...value.committerContext,
                runtimeGeneration: 1 as never,
              }),
            ).toBeNull();
            expect(
              history.resolveHistoricalSignerPublicationManager({
                ...value.managerContext,
                managerSigningPublicKeyHash: new Uint8Array(32),
              }),
            ).toBeNull();
            expect(
              history.resolveHistoricalSignerPublicationManager({
                ...value.managerContext,
                signerPublicKey: new Uint8Array(32),
              }),
            ).toBeNull();
            return "used";
          },
        }),
      ).toBe("used");
      expect(value.calls.filter((stage) => stage === "devices")).toHaveLength(
        1,
      );
      expect(
        value.prepared.signerPublication.signerPublicKey.some(
          (byte) => byte !== 0,
        ),
      ).toBe(true);
      expect(
        value.prepared.intended.domainEnvelopes[0]!.envelopeBytes.ciphertext.some(
          (byte) => byte !== 0,
        ),
      ).toBe(true);
      expect(borrowed.every((key) => key.every((byte) => byte === 0))).toBe(
        true,
      );
      expect(
        escaped!.resolveHistoricalRuntimeCommitter(value.committerContext),
      ).toBeNull();
      expect(
        escaped!.resolveHistoricalSignerPublicationManager(
          value.managerContext,
        ),
      ).toBeNull();
    } finally {
      value.publication.mockRestore();
    }
  });

  test("accepts retained revoked device keys as historical verification authority", async () => {
    const value = await fixture((stage, rows) =>
      stage === "devices"
        ? rows.map((row) => ({ ...row, state: "revoked" }))
        : rows,
    );
    try {
      expect(
        await withProtectedTaskResultSignerHistory({
          ...value.input,
          use: () => "retained",
        }),
      ).toBe("retained");
    } finally {
      value.publication.mockRestore();
    }
  });

  for (const revision of ["2", 2n] as const) {
    test(`accepts raw Postgres ${typeof revision} device revision counters`, async () => {
      const value = await fixture((stage, rows) =>
        stage === "devices"
          ? rows.map((row) => row["device_id"] === COMMITTER
            ? { ...row, revision }
            : row)
          : rows,
      );
      try {
        expect(
          await withProtectedTaskResultSignerHistory({
            ...value.input,
            use: () => "raw-counter",
          }),
        ).toBe("raw-counter");
      } finally {
        value.publication.mockRestore();
      }
    });
  }

  for (const revision of [
    "",
    " 3",
    "03",
    "3.0",
    "3e0",
    "-1",
    "9007199254740992",
    -1n,
    9007199254740992n,
    3.5,
  ] as const) {
    test(`rejects malformed raw device revision ${String(revision)}`, async () => {
      const value = await fixture((stage, rows) =>
        stage === "devices"
          ? rows.map((row) => ({ ...row, revision }))
          : rows,
      );
      let used = false;
      try {
        await fails(withProtectedTaskResultSignerHistory({
          ...value.input,
          use: () => {
            used = true;
          },
        }));
        expect(used).toBe(false);
      } finally {
        value.publication.mockRestore();
      }
    });
  }

  for (const failure of [
    "missing",
    "duplicate",
    "state",
    "revision",
    "human",
    "committer-key",
    "manager-key",
    "hash",
    "generation",
    "authorization",
  ]) {
    test(`rejects ${failure} history without calling use`, async () => {
      const value = await fixture((stage, rows) => {
        if (stage === "devices") {
          if (failure === "missing") return [];
          if (failure === "duplicate") return [rows[0]!, rows[0]!];
          return rows.map((row) => ({
            ...row,
            ...(failure === "state" ? { state: "pending" } : {}),
            ...(failure === "revision" ? { revision: 1 } : {}),
            ...(failure === "human" ? { human_id: "other" } : {}),
            ...((failure === "committer-key" &&
              row["device_id"] === COMMITTER) ||
            (failure === "manager-key" && row["device_id"] === MANAGER)
              ? { signing_public_key: new Uint8Array(32) }
              : {}),
          }));
        }
        if (stage === "envelope" && failure === "hash")
          return rows.map((row) => ({
            ...row,
            envelope_hash: new Uint8Array(32),
          }));
        if (stage === "state" && failure === "generation")
          return rows.map((row) => ({ ...row, runtime_generation: 1 }));
        if (stage === "state" && failure === "authorization")
          return rows.map((row) => ({ ...row, authorization_revision: 8 }));
        return rows;
      });
      let used = false;
      try {
        await fails(
          withProtectedTaskResultSignerHistory({
            ...value.input,
            use: () => {
              used = true;
            },
          }),
        );
        expect(used).toBe(false);
      } finally {
        value.publication.mockRestore();
      }
    });
  }

  test("rejects publication signature substitution and changed historical context", async () => {
    const value = await fixture();
    try {
      const changed = structuredClone(value.prepared.signerPublication);
      changed.signature[0] = changed.signature[0]! ^ 1;
      value.publication.mockResolvedValue(changed);
      await fails(
        withProtectedTaskResultSignerHistory({
          ...value.input,
          use: () => true,
        }),
      );
      value.publication.mockImplementation(async () =>
        structuredClone(value.prepared.signerPublication),
      );
      await withProtectedTaskResultSignerHistory({
        ...value.input,
        use: (history) => {
          expect(
            history.resolveHistoricalRuntimeCommitter({
              ...value.committerContext,
              committerDeviceId: cryptoDeviceId(MANAGER),
            }),
          ).toBeNull();
          expect(
            history.resolveHistoricalRuntimeCommitter({
              ...value.committerContext,
              domainEpoch: domainEpoch(5),
            }),
          ).toBeNull();
          expect(
            history.resolveHistoricalSignerPublicationManager({
              ...value.managerContext,
              managerAuthorizationRevision: authorizationRevision(4),
            }),
          ).toBeNull();
          expect(
            history.resolveHistoricalSignerPublicationManager({
              ...value.managerContext,
              operationId: "other-operation",
            }),
          ).toBeNull();
        },
      });
    } finally {
      value.publication.mockRestore();
    }
  });

  test("rejects Runtime rotation before callback and after use", async () => {
    for (const afterUse of [false, true]) {
      let reads = 0;
      const value = await fixture((stage, rows) =>
        stage === "state" && ++reads >= (afterUse ? 3 : 2)
          ? rows.map((row) => ({ ...row, runtime_generation: 1 }))
          : rows,
      );
      let used = false;
      try {
        await fails(
          withProtectedTaskResultSignerHistory({
            ...value.input,
            use: () => {
              used = true;
            },
          }),
        );
        expect(used).toBe(afterUse);
      } finally {
        value.publication.mockRestore();
      }
    }
  });

  test("wipes borrowed keys on callback failure and rejects missing publication", async () => {
    const value = await fixture();
    let borrowed: Uint8Array | null = null;
    try {
      await fails(
        withProtectedTaskResultSignerHistory({
          ...value.input,
          use: (history) => {
            borrowed = history.resolveHistoricalRuntimeCommitter(
              value.committerContext,
            );
            throw new Error("result failed");
          },
        }),
      );
      expect(borrowed).not.toBeNull();
      expect(borrowed!.every((byte) => byte === 0)).toBe(true);
      value.publication.mockResolvedValue(null);
      await fails(
        withProtectedTaskResultSignerHistory({
          ...value.input,
          use: () => true,
        }),
      );
    } finally {
      value.publication.mockRestore();
    }
  });
});
