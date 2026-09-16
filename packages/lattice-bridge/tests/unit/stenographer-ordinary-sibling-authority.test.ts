import {describe, expect, test} from "bun:test";
import type {ProcessorTransformCapability, ProcessorTransformInput} from "@nautilo/lattice-crypto";
import type {BackgroundAuthorizationIssuerContextV2} from "@nautilo/lattice-crypto/background";

import {withVerifiedStenographerOrdinarySiblings} from
  "../../src/server/journal/stenographer-data-operation.ts";
import type {
  CurrentProcessorHeldAuthority,
  WithCurrentProcessorPublicationAuthority,
} from "../../src/server/storage/postgres-current-processor-transform-object-port.ts";

const CONTEXT = Object.freeze({}) as BackgroundAuthorizationIssuerContextV2;
const OUTPUTS: readonly ProcessorTransformInput[] = Object.freeze([{
  objectId: "journal/event/work-1/slot-000",
  plaintext: new Uint8Array([1, 2, 3]),
}]);
const EXECUTOR = Object.freeze({
  query: async () => [],
}) as unknown as CurrentProcessorHeldAuthority["executor"];

function capability(
  beforeBorrowedCallback?: () => void,
): ProcessorTransformCapability {
  return {
    openInputs: async () => [],
    publishOutputs: async () => {},
    withPublishedOutputs: async <Value>(
      use: (
        outputs: readonly ProcessorTransformInput[],
      ) => Value | Promise<Value>,
    ): Promise<Value> => {
      beforeBorrowedCallback?.();
      return use(OUTPUTS);
    },
  } as unknown as ProcessorTransformCapability;
}

function authorityOwner(isCurrent: () => boolean = () => true) {
  const committed: string[] = [];
  const attempted: string[] = [];
  let authorityCalls = 0;
  let activeAuthorities = 0;
  let maximumActiveAuthorities = 0;
  let product: CurrentProcessorHeldAuthority["product"];
  const withCurrentAuthority: WithCurrentProcessorPublicationAuthority =
    async input => {
      authorityCalls += 1;
      expect(input.context).toBe(CONTEXT);
      if (!isCurrent()) return null;
      activeAuthorities += 1;
      maximumActiveAuthorities = Math.max(
        maximumActiveAuthorities,
        activeAuthorities,
      );
      const staged: string[] = [];
      product = {
        query: async (statement: string) => {
          staged.push(statement);
          attempted.push(statement);
          return [];
        },
      } as unknown as NonNullable<CurrentProcessorHeldAuthority["product"]>;
      try {
        const result = await input.use({
          executor: EXECUTOR,
          issuerSigningPublicKey: new Uint8Array(32).fill(0x41),
          product,
        });
        input.signal?.throwIfAborted();
        committed.push(...staged);
        return result;
      } finally {
        activeAuthorities -= 1;
      }
    };
  return {
    attempted,
    committed,
    withCurrentAuthority,
    authorityCalls: () => authorityCalls,
    maximumActiveAuthorities: () => maximumActiveAuthorities,
    product: () => product,
  };
}

describe("Stenographer ordinary sibling authority", () => {
  test("attaches borrowed outputs through the exact held product transaction", async () => {
    const owner = authorityOwner();
    let receivedHeld: CurrentProcessorHeldAuthority | undefined;
    let receivedOutputs: readonly ProcessorTransformInput[] | undefined;

    expect(await withVerifiedStenographerOrdinarySiblings({
      capability: capability(),
      context: CONTEXT,
      withCurrentAuthority: owner.withCurrentAuthority,
      signal: new AbortController().signal,
      attach: async (held, outputs) => {
        receivedHeld = held;
        receivedOutputs = outputs;
        await held.product!.query("insert ordinary sibling");
        return "attached";
      },
    })).toBe("attached");
    expect(receivedHeld?.product).toBe(owner.product());
    expect(receivedOutputs).toBe(OUTPUTS);
    expect(owner.authorityCalls()).toBe(1);
    expect(owner.maximumActiveAuthorities()).toBe(1);
    expect(owner.committed).toEqual(["insert ordinary sibling"]);
  });

  test("device revocation after borrow authorization prevents attachment", async () => {
    let currentDevice = true;
    let attachCalls = 0;
    const owner = authorityOwner(() => currentDevice);
    const error = await withVerifiedStenographerOrdinarySiblings({
      capability: capability(() => {
        expect(currentDevice).toBeTrue();
        currentDevice = false;
      }),
      context: CONTEXT,
      withCurrentAuthority: owner.withCurrentAuthority,
      signal: new AbortController().signal,
      attach: async () => {
        attachCalls += 1;
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({failureClass: "stale"});
    expect(owner.authorityCalls()).toBe(1);
    expect(attachCalls).toBe(0);
    expect(owner.attempted).toEqual([]);
    expect(owner.committed).toEqual([]);
  });

  test("an abort before borrowing never enters current authority", async () => {
    const owner = authorityOwner();
    const controller = new AbortController();
    controller.abort(new Error("cancelled before attachment"));

    const error = await withVerifiedStenographerOrdinarySiblings({
      capability: capability(),
      context: CONTEXT,
      withCurrentAuthority: owner.withCurrentAuthority,
      signal: controller.signal,
      attach: async () => {
        throw new Error("attachment must not run");
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBe(controller.signal.reason);
    expect(owner.authorityCalls()).toBe(0);
    expect(owner.committed).toEqual([]);
  });

  test("an abort during attachment rolls back the staged sibling write", async () => {
    const owner = authorityOwner();
    const controller = new AbortController();

    const error = await withVerifiedStenographerOrdinarySiblings({
      capability: capability(),
      context: CONTEXT,
      withCurrentAuthority: owner.withCurrentAuthority,
      signal: controller.signal,
      attach: async held => {
        await held.product!.query("insert ordinary sibling");
        controller.abort(new Error("cancelled during attachment"));
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBe(controller.signal.reason);
    expect(owner.authorityCalls()).toBe(1);
    expect(owner.attempted).toEqual(["insert ordinary sibling"]);
    expect(owner.committed).toEqual([]);
  });
});
