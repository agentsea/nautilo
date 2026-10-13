import { describe, expect, mock, test } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

const realBridgeServer = await import("@nautilo/lattice-bridge/server");
const realRuntime = await import("@nautilo/runtime");

const productHandles: unknown[] = [];
let prepared = false;
let persistHandle: unknown;
let currentAssertions = 0;

class FakeExactProduct {
  readonly handle: unknown;
  readonly assertCurrentAuthority: (() => Promise<void>) | undefined;

  constructor(input: { handle: unknown; assertCurrentAuthority?: () => Promise<void> }) {
    this.handle = input.handle;
    this.assertCurrentAuthority = input.assertCurrentAuthority;
    productHandles.push(input.handle);
  }

  async planNativeChange() {
    await this.assertCurrentAuthority?.();
    await this.assertCurrentAuthority?.();
    return {
      status: "success" as const,
      value: { status: "prepared" as const, plan: {}, sourceNamespaceId: "ns" },
    };
  }

  async commitNativePrepared(input: { persist(): Promise<string> }) {
    await this.assertCurrentAuthority?.();
    await input.persist();
    await this.assertCurrentAuthority?.();
    return { status: "success" as const,
      value: { status: "updated" as const, memoryId: "memory" } };
  }

  async reconcileNativeCommitted() {
    return true;
  }
}

mock.module("@nautilo/lattice-bridge/server", () => ({
  ...realBridgeServer,
  PostgresAgentMemoryExactAccessProduct: FakeExactProduct,
  persistForegroundAgentMemoryNativeExactAccess: async (
    input: { handle: unknown },
  ) => {
    persistHandle = input.handle;
    return "created" as const;
  },
}));

mock.module("@nautilo/runtime", () => ({
  ...realRuntime,
  createForegroundDomainMemoryExactAccess: () => ({ prepare: async () => ({}) }),
  createForegroundDomainProtectedAgentMemoryAccessPort: (input: {
    product: FakeExactProduct;
    persist(publication: unknown): Promise<string>;
  }) => ({
    async prepareApproval() {
      const planned = await input.product.planNativeChange();
      if (planned.status !== "success") return planned;
      prepared = true;
      return { status: "success" as const, value: { reference: {}, preview: {} } };
    },
    async change() {
      if (!prepared) return { status: "unavailable" as const,
        reason: "authorization_required" as const };
      return input.product.commitNativePrepared({
        persist: () => input.persist({}),
      });
    },
  }),
}));

mock.module("../../src/routes/foreground-message-product-store", () => ({
  createForegroundProductTransactionContext: () => {
    throw new Error("static foreground product context must not be opened");
  },
}));

const { createForegroundMemoryAccessPort } = await import(
  "../../src/routes/foreground-memory-repository"
);

const envelope: MemoryAccessEnvelope = {
  ownerId: "human",
  actorId: "actor",
  agentId: "agent",
  roomId: "room",
  readableNamespaces: ["namespace"],
  mutableNamespaces: ["namespace"],
  writableNamespaces: ["namespace"],
  toolPolicy: {},
};

describe("foreground Memory current exact-access owner", () => {
  test("retains approval state while each effect borrows fresh Agent resources", async () => {
    prepared = false;
    persistHandle = undefined;
    currentAssertions = 0;
    productHandles.length = 0;
    let generation = 0;
    const port = await createForegroundMemoryAccessPort({
      envelope,
      domain: {
        subjectUserId: "human",
        agentId: "agent",
        crypto: {},
        entities: {},
        publication: { runtime: {}, signerKeyId: "signer",
          agentAuthorizationRevision: 1 },
        read: () => Promise.resolve(null),
      } as never,
      resolveGrantUserNamespace: () => Promise.resolve(null),
      withCurrentExactAccess: async use => {
        generation += 1;
        const handle = Object.freeze({ role: "nautilo_agent", generation });
        const cryptoHandle = Object.freeze({ role: "nautilo_crypto", generation });
        return use({
          productContext: { handle, canonicalRunner: {} },
          assertCurrentAuthority: () => {
            currentAssertions += 1;
            return Promise.resolve();
          },
          exact: { handle: cryptoHandle, namespaceKeys: {},
            resolveHistoricalAgentSignerAuthority: () => Promise.resolve(null),
            resolveLiveShadowAgentSigner: () => null,
            resolveCurrentAgentSigner: () => null,
            read: () => Promise.resolve(null) },
        } as never);
      },
    });

    expect((await port.prepareApproval!({} as never)).status).toBe("success");
    expect((await port.change({} as never)).status).toBe("success");
    expect(generation).toBe(2);
    expect(productHandles).toHaveLength(2);
    expect(productHandles[0]).not.toBe(productHandles[1]);
    expect(persistHandle).toEqual({ role: "nautilo_crypto", generation: 2 });
    expect(currentAssertions).toBe(4);
  });

  test("fails closed when the owner cannot lend current resources", async () => {
    prepared = false;
    productHandles.length = 0;
    const port = await createForegroundMemoryAccessPort({
      envelope,
      domain: { subjectUserId: "human", agentId: "agent", crypto: {},
        entities: {}, publication: { runtime: {}, signerKeyId: "signer",
          agentAuthorizationRevision: 1 }, read: () => Promise.resolve(null) } as never,
      resolveGrantUserNamespace: () => Promise.resolve(null),
      withCurrentExactAccess: () => Promise.resolve(null),
    });
    expect(await port.prepareApproval!({} as never)).toEqual({
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(productHandles).toHaveLength(0);
  });
});
