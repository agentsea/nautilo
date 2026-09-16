import { describe, expect, test } from "bun:test";
import type {
  DurableSleepClaim,
  DurableSleepClaimOptions,
  DurableSleepClaimResult,
  DurableSleepSemanticPort,
  DurableSleepWorkPort,
} from "@nautilo/reflection/durable";

import {
  bindReflectionSemanticDataOperationPort,
} from "../../src/server/reflection/semantic-data-operation-port.ts";
import {
  ClassifiedDataOperationError,
  type DataOperationPolicyBinding,
} from "../../src/transition/encryption-data-operation-owner.ts";
import type { LiveShadowEncryptionTransitionPolicy } from
  "../../src/transition/encryption-transition-policy.ts";

function claim(
  id: string,
  stage: DurableSleepClaim["stage"] = "authority_projection",
): DurableSleepClaim {
  return Object.freeze({
    logicalObjectRef: id,
    generation: 1,
    recordRef: id,
    changeReason: "created",
    stage,
    leaseToken: `lease-${id}`,
  });
}

function policyBinding(input: Readonly<{
  policy: LiveShadowEncryptionTransitionPolicy;
  token?: number;
  validTokens?: Set<number>;
  calls?: string[];
}>): DataOperationPolicyBinding & { token: number } {
  const binding = {
    token: input.token ?? 1,
    async resolve() {
      input.calls?.push(`resolve:${binding.token}`);
      return { policy: input.policy, revalidationToken: binding.token };
    },
    async revalidate(token: number) {
      input.calls?.push(`revalidate:${token}`);
      if (input.validTokens?.has(token) === false || (
        input.validTokens === undefined && token !== binding.token
      )) {
        throw new ClassifiedDataOperationError("stale", "policy changed");
      }
    },
  };
  return binding;
}

function workPort(input: Readonly<{
  next: (
    signal?: AbortSignal,
    options?: DurableSleepClaimOptions,
  ) => Promise<DurableSleepClaimResult>;
  calls?: string[];
}>): DurableSleepWorkPort {
  const port: DurableSleepWorkPort & { identity: string } = {
    identity: "work-port",
    async claimNext(signal, options) {
      expect(this.identity).toBe("work-port");
      input.calls?.push("claim");
      return input.next(signal, options);
    },
    async checkpoint() {
      expect(this.identity).toBe("work-port");
      input.calls?.push("checkpoint");
      return { status: "accepted" };
    },
    async pause() {
      expect(this.identity).toBe("work-port");
      input.calls?.push("pause");
      return { status: "accepted" };
    },
    async complete() {
      expect(this.identity).toBe("work-port");
      input.calls?.push("complete");
      return { status: "accepted" };
    },
    async defer() {
      expect(this.identity).toBe("work-port");
      input.calls?.push("defer");
      return { status: "deferred" };
    },
    async enqueue() {
      expect(this.identity).toBe("work-port");
      input.calls?.push("enqueue");
    },
  };
  return port;
}

function semanticPort(input: Readonly<{
  calls: string[];
  label: "ordinary" | "protected";
  includeAttempt?: boolean;
  includeBatch?: boolean;
}>): DurableSleepSemanticPort {
  const call = (method: string) => input.calls.push(`${input.label}:${method}`);
  return {
    ...(input.includeAttempt === true
      ? {
          openOrganizationAttempt: async () => {
            call("open-attempt");
            return {
              assertCurrent: async () => { call("attempt-current"); },
              publish: async <Value>(publish: () => Promise<Value>) => {
                call("attempt-publish");
                return publish();
              },
              close: async () => { call("attempt-close"); },
            };
          },
        }
      : {}),
    resolveParentConflict: async () => {
      call("parent-conflict");
      return { status: "not_applicable" };
    },
    modelLaneReadiness: async () => {
      call("model-readiness");
      return { status: "ready" };
    },
    ensureAuthority: async () => {
      call("authority");
      return { status: "ready" };
    },
    ensureSearchProjection: async () => {
      call("search");
      return { status: "ready" };
    },
    loadOrganizerView: async () => {
      call("view");
      return { status: "no_change", reason: "already_covered" };
    },
    resolveDependencyLoss: async () => {
      call("dependency");
      return { status: "not_applicable" };
    },
    invokeOrganizer: async () => {
      call("organizer");
      return "proposal";
    },
    ...(input.includeBatch === true
      ? {
          invokeOrganizerBatch: async () => {
            call("organizer-batch");
            return "proposal-batch";
          },
        }
      : {}),
    applyProposal: async () => {
      call("apply");
      return { status: "unavailable", failureCode: "publication_unavailable" };
    },
  };
}

async function expectUnsupported(work: Promise<unknown>): Promise<void> {
  const error = await work.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(ClassifiedDataOperationError);
  expect((error as ClassifiedDataOperationError).failureClass).toBe(
    "unsupported",
  );
}

const POLICIES = {
  plain: { mode: "plaintext_only", shadowBehavior: "fallback" },
  fallback: { mode: "shadow_encryption", shadowBehavior: "fallback" },
  strict: { mode: "shadow_encryption", shadowBehavior: "strict" },
  full: { mode: "encrypted_only", shadowBehavior: "fallback" },
} as const satisfies Record<string, LiveShadowEncryptionTransitionPolicy>;

const HIERARCHY_BUDGET = Object.freeze({
  maxModelCalls: 1,
  maxVisitedRecords: 1,
  maxCreatedRecords: 1,
  maxTraversalWork: 1,
  maxStatementCharacters: 1_024,
});

describe("Reflection semantic data operation port", () => {
  test.each([
    ["plain", "ordinary", { ordinary: "any", protected: "none" }],
    ["fallback", "ordinary", {
      ordinary: "without_protected_head",
      protected: "authority_projection",
    }],
    ["fallback", "protected", {
      ordinary: "without_protected_head",
      protected: "authority_projection",
    }],
    ["strict", "protected", {
      ordinary: "none",
      protected: "authority_projection",
    }],
    ["full", "protected", {
      ordinary: "none",
      protected: "authority_projection",
    }],
  ] as const)(
    "%s policy admits one %s authority representation",
    async (policyName, executionRepresentation, admission) => {
      const selected = claim(`${policyName}-${executionRepresentation}`);
      const calls: string[] = [];
      let observed: DurableSleepClaimOptions | undefined;
      const ports = bindReflectionSemanticDataOperationPort({
        policy: policyBinding({ policy: POLICIES[policyName], calls }),
        work: workPort({
          calls,
          next: async (_signal, options) => {
            observed = options;
            return {
              status: "claimed",
              claim: selected,
              executionRepresentation,
              maximumStage: executionRepresentation === "protected"
                ? "authority_projection"
                : "organization",
            };
          },
        }),
        ordinary: semanticPort({ calls, label: "ordinary" }),
        protected: semanticPort({ calls, label: "protected" }),
      });

      const result = await ports.work.claimNext(undefined, {
        maximumStage: "organization",
      });
      expect(result.status).toBe("claimed");
      expect(observed).toEqual({
        maximumStage: "organization",
        representationAdmission: admission,
      });
      expect(await ports.semantic.ensureAuthority(selected)).toEqual({
        status: "ready",
      });
      expect(calls).toContain(`${executionRepresentation}:authority`);
      expect(calls).not.toContain(`${executionRepresentation === "ordinary"
        ? "protected"
        : "ordinary"}:authority`);
    },
  );

  test("rejects absent, substituted, and above-ceiling claim selections", async () => {
    const invalid: readonly Omit<Extract<DurableSleepClaimResult, {
      status: "claimed";
    }>, "status">[] = [
      { claim: claim("missing-representation"), maximumStage: "organization" },
      {
        claim: claim("missing-ceiling"),
        executionRepresentation: "ordinary",
      },
      {
        claim: claim("protected-widened"),
        executionRepresentation: "protected",
        maximumStage: "organization",
      },
      {
        claim: claim("ordinary-substituted"),
        executionRepresentation: "ordinary",
        maximumStage: "search_projection",
      },
      {
        claim: claim("above-ceiling", "organization"),
        executionRepresentation: "protected",
        maximumStage: "authority_projection",
      },
    ];
    for (const selected of invalid) {
      const calls: string[] = [];
      const ports = bindReflectionSemanticDataOperationPort({
        policy: policyBinding({ policy: POLICIES.fallback }),
        work: workPort({
          calls,
          next: async () => ({ status: "claimed", ...selected }),
        }),
        ordinary: semanticPort({ calls, label: "ordinary" }),
        protected: semanticPort({ calls, label: "protected" }),
      });
      expect(ports.work.claimNext()).rejects.toThrow(
        "Invalid Reflection claimed cohort",
      );
      await Promise.resolve();
      expect(calls).toContain("pause");
      expect(calls).not.toContain("ordinary:authority");
      expect(calls).not.toContain("protected:authority");
    }
  });

  test("policy changes release a newly claimed lease and deny later callbacks", async () => {
    {
      const selected = claim("changed-during-claim");
      const calls: string[] = [];
      const policy = policyBinding({ policy: POLICIES.plain, calls });
      const ports = bindReflectionSemanticDataOperationPort({
        policy,
        work: workPort({
          calls,
          next: async () => {
            policy.token = 2;
            return {
              status: "claimed",
              claim: selected,
              executionRepresentation: "ordinary",
              maximumStage: "organization",
            };
          },
        }),
        ordinary: semanticPort({ calls, label: "ordinary" }),
        protected: semanticPort({ calls, label: "protected" }),
      });
      expect(ports.work.claimNext()).rejects.toMatchObject({
        failureClass: "stale",
      });
      await Promise.resolve();
      expect(calls).toContain("pause");
    }
    {
      const selected = claim("changed-before-semantic");
      const calls: string[] = [];
      const policy = policyBinding({ policy: POLICIES.plain, calls });
      const ports = bindReflectionSemanticDataOperationPort({
        policy,
        work: workPort({
          next: async () => ({
            status: "claimed",
            claim: selected,
            executionRepresentation: "ordinary",
            maximumStage: "organization",
          }),
        }),
        ordinary: semanticPort({ calls, label: "ordinary" }),
        protected: semanticPort({ calls, label: "protected" }),
      });
      await ports.work.claimNext();
      policy.token = 2;
      expect(ports.semantic.ensureAuthority(selected)).rejects.toMatchObject({
        failureClass: "stale",
      });
      await Promise.resolve();
      expect(calls).not.toContain("ordinary:authority");
    }
  });

  test("unknown claims and mixed-policy Organizer batches never reach a provider", async () => {
    const first = claim("first", "organization");
    const second = claim("second", "organization");
    const unknown = claim("unknown", "organization");
    const calls: string[] = [];
    const validTokens = new Set([1, 2]);
    const policy = policyBinding({
      policy: POLICIES.plain,
      validTokens,
      calls,
    });
    const queue = [first, second];
    const ports = bindReflectionSemanticDataOperationPort({
      policy,
      work: workPort({
        next: async () => ({
          status: "claimed",
          claim: queue.shift()!,
          executionRepresentation: "ordinary",
          maximumStage: "organization",
        }),
      }),
      ordinary: semanticPort({
        calls,
        label: "ordinary",
        includeBatch: true,
      }),
      protected: semanticPort({ calls, label: "protected" }),
    });
    await ports.work.claimNext();
    policy.token = 2;
    await ports.work.claimNext();

    expect(ports.semantic.ensureAuthority(unknown)).rejects.toMatchObject({
      failureClass: "authority",
    });
    expect(ports.semantic.invokeOrganizerBatch?.([first, second], "prompt"))
      .rejects.toThrow("mixes policy or representation");
    await Promise.resolve();
    expect(calls).not.toContain("ordinary:organizer-batch");
  });

  test("same-policy Organizer batches validate every claim before and after provider use", async () => {
    const first = claim("batch-first", "organization");
    const second = claim("batch-second", "organization");
    const calls: string[] = [];
    const queue = [first, second];
    const ports = bindReflectionSemanticDataOperationPort({
      policy: policyBinding({ policy: POLICIES.plain, calls }),
      work: workPort({
        next: async () => ({
          status: "claimed",
          claim: queue.shift()!,
          executionRepresentation: "ordinary",
          maximumStage: "organization",
        }),
      }),
      ordinary: semanticPort({
        calls,
        label: "ordinary",
        includeBatch: true,
      }),
      protected: semanticPort({ calls, label: "protected" }),
    });
    await ports.work.claimNext();
    await ports.work.claimNext();
    calls.length = 0;
    expect(await ports.semantic.invokeOrganizerBatch?.(
      [first, second],
      "prompt",
    )).toBe("proposal-batch");
    expect(calls).toEqual([
      "revalidate:1",
      "revalidate:1",
      "ordinary:organizer-batch",
      "revalidate:1",
      "revalidate:1",
    ]);
  });

  test("protected claims expose authority only and deny body, provider, and attempt callbacks", async () => {
    const selected = claim("protected");
    const calls: string[] = [];
    const ports = bindReflectionSemanticDataOperationPort({
      policy: policyBinding({ policy: POLICIES.full }),
      work: workPort({
        next: async () => ({
          status: "claimed",
          claim: selected,
          executionRepresentation: "protected",
          maximumStage: "authority_projection",
        }),
      }),
      ordinary: semanticPort({
        calls,
        label: "ordinary",
        includeAttempt: true,
        includeBatch: true,
      }),
      protected: semanticPort({ calls, label: "protected" }),
    });
    await ports.work.claimNext();
    expect(await ports.semantic.ensureAuthority(selected)).toEqual({
      status: "ready",
    });
    await expectUnsupported(ports.semantic.ensureSearchProjection(selected));
    await expectUnsupported(ports.semantic.loadOrganizerView(selected));
    await expectUnsupported(ports.semantic.resolveParentConflict({
      claim: selected,
    }));
    await expectUnsupported(ports.semantic.resolveDependencyLoss({
      claim: selected,
      idempotencyKey: "dependency",
      budget: HIERARCHY_BUDGET,
    }));
    await expectUnsupported(ports.semantic.invokeOrganizer(selected, "prompt"));
    await expectUnsupported(ports.semantic.applyProposal({
      claim: selected,
      proposal: { operation: "no_change" },
      idempotencyKey: "apply",
      budget: HIERARCHY_BUDGET,
    }));
    await expectUnsupported(ports.semantic.openOrganizationAttempt!(selected));
    await expectUnsupported(
      ports.semantic.invokeOrganizerBatch!([selected], "prompt"),
    );
    expect(calls).toEqual(["protected:authority"]);
  });

  test.each(["strict", "full"] as const)(
    "%s policy routes a full protected semantic claim only to the protected provider",
    async policyName => {
      const selected = claim(`full-protected-${policyName}`, "organization");
      const calls: string[] = [];
      const protectedSemantic = semanticPort({
        calls,
        label: "protected",
        includeAttempt: true,
        includeBatch: true,
      });
      const ports = bindReflectionSemanticDataOperationPort({
        policy: policyBinding({ policy: POLICIES[policyName], calls }),
        work: workPort({
          next: async (_signal, options) => {
            expect(options?.representationAdmission).toEqual({
              ordinary: "none",
              protected: "organization",
            });
            return {
              status: "claimed",
              claim: selected,
              executionRepresentation: "protected",
              maximumStage: "organization",
            };
          },
        }),
        ordinary: semanticPort({
          calls,
          label: "ordinary",
          includeAttempt: true,
          includeBatch: true,
        }),
        protected: {
          ensureAuthority: protectedSemantic.ensureAuthority.bind(protectedSemantic),
          semantic: protectedSemantic,
        },
      });

      await ports.work.claimNext();
      expect(await ports.semantic.ensureAuthority(selected)).toEqual({ status: "ready" });
      expect(await ports.semantic.ensureSearchProjection(selected)).toEqual({ status: "ready" });
      expect(await ports.semantic.loadOrganizerView(selected)).toEqual({
        status: "no_change",
        reason: "already_covered",
      });
      expect(await ports.semantic.resolveParentConflict({ claim: selected })).toEqual({
        status: "not_applicable",
      });
      expect(await ports.semantic.resolveDependencyLoss({
        claim: selected,
        idempotencyKey: "dependency",
        budget: HIERARCHY_BUDGET,
      })).toEqual({ status: "not_applicable" });
      expect(await ports.semantic.invokeOrganizer(selected, "prompt")).toBe("proposal");
      expect(await ports.semantic.applyProposal({
        claim: selected,
        proposal: { operation: "no_change" },
        idempotencyKey: "apply",
        budget: HIERARCHY_BUDGET,
      })).toEqual({ status: "unavailable", failureCode: "publication_unavailable" });
      expect(await ports.semantic.invokeOrganizerBatch?.([selected], "prompt"))
        .toBe("proposal-batch");
      const attempt = await ports.semantic.openOrganizationAttempt!(selected);
      await attempt.assertCurrent();
      expect(await attempt.publish(async () => "published")).toBe("published");
      await attempt.close("unavailable");

      expect(calls.filter(value => value.startsWith("ordinary:"))).toEqual([]);
      for (const method of [
        "authority", "search", "view", "parent-conflict", "dependency",
        "organizer", "apply", "organizer-batch", "open-attempt",
        "attempt-current", "attempt-publish", "attempt-close",
      ]) {
        expect(calls).toContain(`protected:${method}`);
      }
    },
  );

  test("rejects mixed ordinary and protected Organizer batches before either provider runs", async () => {
    const protectedClaim = claim("mixed-protected", "organization");
    const ordinaryClaim = claim("mixed-ordinary", "organization");
    const calls: string[] = [];
    const protectedSemantic = semanticPort({ calls, label: "protected", includeBatch: true });
    const queue = [
      {
        claim: protectedClaim,
        executionRepresentation: "protected" as const,
        maximumStage: "organization" as const,
      },
      {
        claim: ordinaryClaim,
        executionRepresentation: "ordinary" as const,
        maximumStage: "organization" as const,
      },
    ];
    const ports = bindReflectionSemanticDataOperationPort({
      policy: policyBinding({ policy: POLICIES.fallback, calls }),
      work: workPort({
        next: async () => ({ status: "claimed", ...queue.shift()! }),
      }),
      ordinary: semanticPort({ calls, label: "ordinary", includeBatch: true }),
      protected: {
        ensureAuthority: protectedSemantic.ensureAuthority.bind(protectedSemantic),
        semantic: protectedSemantic,
      },
    });
    await ports.work.claimNext();
    await ports.work.claimNext();
    calls.length = 0;

    expect(ports.semantic.invokeOrganizerBatch?.(
      [protectedClaim, ordinaryClaim],
      "prompt",
    )).rejects.toThrow("mixes policy or representation");
    await Promise.resolve();
    expect(calls.filter(value => value.endsWith(":organizer-batch"))).toEqual([]);
  });

  test("shared dispatch batches prepared ordinary and protected questions without reopening either", async () => {
    const calls: string[] = [];
    const a = claim("private-a", "organization"), b = claim("private-b", "organization");
    const queue = [{claim: a, executionRepresentation: "protected" as const}, {claim: b, executionRepresentation: "ordinary" as const}];
    const ordinary = semanticPort({calls, label: "ordinary", includeAttempt: true});
    const protectedSemantic = semanticPort({calls, label: "protected", includeAttempt: true});
    let revoked = false;
    const openAttempt = protectedSemantic.openOrganizationAttempt!;
    protectedSemantic.openOrganizationAttempt = async (current, signal) => {
      const attempt = await openAttempt(current, signal);
      return {...attempt, assertCurrent: async () => {
        if (revoked) throw new Error("Question grant revoked");
        await attempt.assertCurrent();
      }};
    };
    let waiting = true;
    const view: DurableSleepSemanticPort["loadOrganizerView"] = current => Promise.resolve({status: "ready", view: {
      changed: {handle: "R1", dependency: {kind: "record", recordRef: current.recordRef}, snapshot: {
        recordRef: current.recordRef, observedContentFingerprint: current.recordRef, posture: "authored", anchors: [current.recordRef],
        statement: "Prepared evidence", sourceRefs: [], childRecordRefs: [], structuralHeight: 0, lifecycle: "current",
      }}, candidates: [], existingParents: [], maxSelectedChildren: 2,
    }});
    ordinary.loadOrganizerView = view;
    protectedSemantic.loadOrganizerView = current => waiting ? Promise.resolve({status: "waiting", retryAt: 1000}) : view(current);
    const ports = bindReflectionSemanticDataOperationPort({
      policy: policyBinding({policy: POLICIES.fallback, calls}),
      work: workPort({next: async () => ({status: "claimed", maximumStage: "organization", ...queue.shift()!})}),
      ordinary, protected: {ensureAuthority: protectedSemantic.ensureAuthority, semantic: protectedSemantic},
      invokePreparedOrganizerBatch: async selected => {calls.push(`shared:${selected.map(item => item.recordRef).join(",")}`); return "answers";},
    });
    await ports.work.claimNext(); await ports.work.claimNext();
    const attempt = await ports.semantic.openOrganizationAttempt!(a);
    await ports.semantic.loadOrganizerView(a); await ports.semantic.loadOrganizerView(b);
    const waitingError: unknown = await ports.semantic.invokeOrganizerBatch!([a, b], "prompt").catch((error: unknown) => error);
    expect(waitingError instanceof Error && waitingError.message.includes("not ready")).toBe(true);
    expect(calls.some(call => call.startsWith("shared:"))).toBe(false);
    waiting = false; await ports.semantic.loadOrganizerView(a);
    expect(await ports.semantic.invokeOrganizerBatch!([a, b], "prompt")).toBe("answers");
    expect(calls.filter(call => call.startsWith("shared:"))).toEqual(["shared:private-a,private-b"]);
    expect(calls.some(call => call.endsWith(":organizer-batch"))).toBe(false);
    revoked = true;
    const revokedError: unknown = await ports.semantic.invokeOrganizerBatch!([a, b], "prompt").catch((error: unknown) => error);
    expect(revokedError instanceof Error && revokedError.message.includes("revoked")).toBe(true);
    expect(calls.filter(call => call.startsWith("shared:"))).toHaveLength(1);
    await attempt.close("cancelled");
    const closedError: unknown = await ports.semantic.invokeOrganizerBatch!([a, b], "prompt").catch((error: unknown) => error);
    expect(closedError instanceof Error && closedError.message.includes("not ready")).toBe(true);
  });

  test("protected provider calls revalidate before and after use", async () => {
    const selected = claim("protected-stale-after", "organization");
    const calls: string[] = [];
    const policy = policyBinding({ policy: POLICIES.full, calls });
    const protectedSemantic = semanticPort({ calls, label: "protected" });
    protectedSemantic.loadOrganizerView = async () => {
      calls.push("protected:view");
      policy.token += 1;
      return { status: "no_change", reason: "already_covered" };
    };
    const ports = bindReflectionSemanticDataOperationPort({
      policy,
      work: workPort({ next: async () => ({
        status: "claimed",
        claim: selected,
        executionRepresentation: "protected",
        maximumStage: "organization",
      }) }),
      ordinary: semanticPort({ calls, label: "ordinary" }),
      protected: {
        ensureAuthority: protectedSemantic.ensureAuthority.bind(protectedSemantic),
        semantic: protectedSemantic,
      },
    });
    await ports.work.claimNext();
    calls.length = 0;

    expect(ports.semantic.loadOrganizerView(selected)).rejects.toMatchObject({
      failureClass: "stale",
    });
    await Promise.resolve();
    expect(calls).toEqual(["revalidate:1", "protected:view", "revalidate:1"]);
  });

  test("a protected attempt opened across a stale policy boundary is closed", async () => {
    const selected = claim("protected-opening", "organization");
    const calls: string[] = [];
    const policy = policyBinding({ policy: POLICIES.full, calls });
    const protectedSemantic = semanticPort({
      calls,
      label: "protected",
      includeAttempt: true,
    });
    const open = protectedSemantic.openOrganizationAttempt!;
    protectedSemantic.openOrganizationAttempt = async (...args) => {
      const attempt = await open(...args);
      policy.token += 1;
      return attempt;
    };
    const ports = bindReflectionSemanticDataOperationPort({
      policy,
      work: workPort({ next: async () => ({
        status: "claimed",
        claim: selected,
        executionRepresentation: "protected",
        maximumStage: "organization",
      }) }),
      ordinary: semanticPort({ calls, label: "ordinary", includeAttempt: true }),
      protected: {
        ensureAuthority: protectedSemantic.ensureAuthority.bind(protectedSemantic),
        semantic: protectedSemantic,
      },
    });
    await ports.work.claimNext();
    calls.length = 0;

    expect(ports.semantic.openOrganizationAttempt!(selected)).rejects.toMatchObject({
      failureClass: "stale",
    });
    await Promise.resolve();
    expect(calls).toContain("protected:open-attempt");
    expect(calls.filter(value => value === "protected:attempt-close")).toHaveLength(1);
    expect(calls.filter(value => value.startsWith("ordinary:"))).toEqual([]);
  });

  test("ordinary attempts revalidate access but always release after policy changes", async () => {
    const selected = claim("attempt", "organization");
    const calls: string[] = [];
    const policy = policyBinding({ policy: POLICIES.plain, calls });
    const ports = bindReflectionSemanticDataOperationPort({
      policy,
      work: workPort({
        next: async () => ({
          status: "claimed",
          claim: selected,
          executionRepresentation: "ordinary",
          maximumStage: "organization",
        }),
      }),
      ordinary: semanticPort({
        calls,
        label: "ordinary",
        includeAttempt: true,
      }),
      protected: semanticPort({ calls, label: "protected" }),
    });
    await ports.work.claimNext();
    const attempt = await ports.semantic.openOrganizationAttempt!(selected);
    calls.length = 0;
    await attempt.assertCurrent();
    expect(await attempt.publish(async () => {
      calls.push("publication-callback");
      return "published";
    })).toBe("published");
    expect(calls).toContain("ordinary:attempt-current");
    expect(calls).toContain("ordinary:attempt-publish");
    expect(calls).toContain("publication-callback");
    policy.token = 2;
    const count = calls.length;
    expect(attempt.publish(async () => {
      calls.push("denied-publication-callback");
    })).rejects.toMatchObject({ failureClass: "stale" });
    await Promise.resolve();
    expect(calls.slice(count)).not.toContain("denied-publication-callback");
    expect(calls.slice(count)).not.toContain("ordinary:attempt-publish");
    await attempt.close("unavailable");
    expect(calls.filter(value => value === "ordinary:attempt-close")).toHaveLength(1);
  });

  test.each(["policy", "abort"] as const)("releases an attempt when %s changes while opening", async reason => {
    const selected = claim("opening", "organization");
    const calls: string[] = [];
    const policy = policyBinding({policy: POLICIES.plain, calls});
    const controller = new AbortController();
    const ordinary = semanticPort({calls, label: "ordinary", includeAttempt: true});
    const open = ordinary.openOrganizationAttempt!;
    ordinary.openOrganizationAttempt = async (...args) => {
      const attempt = await open(...args);
      if (reason === "policy") policy.token += 1;
      else controller.abort();
      return attempt;
    };
    const ports = bindReflectionSemanticDataOperationPort({
      policy,
      work: workPort({next: async () => ({status: "claimed", claim: selected,
        executionRepresentation: "ordinary", maximumStage: "organization"})}),
      ordinary,
      protected: semanticPort({calls, label: "protected"}),
    });
    await ports.work.claimNext();
    const rejected = await ports.semantic.openOrganizationAttempt!(selected, controller.signal)
      .then(() => false, () => true);
    expect(rejected).toBe(true);
    expect(calls.filter(value => value === "ordinary:attempt-close")).toHaveLength(1);
    expect(calls).not.toContain("ordinary:attempt-publish");
  });

  test.each([
    ["plain", true],
    ["fallback", true],
    ["strict", false],
    ["full", false],
  ] as const)(
    "%s model readiness consults the ordinary provider: %s",
    async (policyName, consultsOrdinary) => {
      const calls: string[] = [];
      const ports = bindReflectionSemanticDataOperationPort({
        policy: policyBinding({ policy: POLICIES[policyName], calls }),
        work: workPort({ next: async () => ({ status: "empty" }) }),
        ordinary: semanticPort({ calls, label: "ordinary" }),
        protected: semanticPort({ calls, label: "protected" }),
      });
      expect(await ports.semantic.modelLaneReadiness?.()).toEqual({
        status: "ready",
      });
      expect(calls.includes("ordinary:model-readiness")).toBe(consultsOrdinary);
    },
  );

  test("cancellation before policy resolution invokes no work or semantic callback", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const ports = bindReflectionSemanticDataOperationPort({
      policy: policyBinding({ policy: POLICIES.plain, calls }),
      work: workPort({
        calls,
        next: async () => ({ status: "empty" }),
      }),
      ordinary: semanticPort({ calls, label: "ordinary" }),
      protected: semanticPort({ calls, label: "protected" }),
    });
    expect(ports.work.claimNext(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await Promise.resolve();
    expect(calls).toEqual([]);

    const lateCalls: string[] = [];
    const lateController = new AbortController();
    const selected = claim("cancelled-after-claim");
    const late = bindReflectionSemanticDataOperationPort({
      policy: policyBinding({ policy: POLICIES.plain, calls: lateCalls }),
      work: workPort({
        calls: lateCalls,
        next: async () => {
          lateController.abort();
          return {
            status: "claimed",
            claim: selected,
            executionRepresentation: "ordinary",
            maximumStage: "organization",
          };
        },
      }),
      ordinary: semanticPort({ calls: lateCalls, label: "ordinary" }),
      protected: semanticPort({ calls: lateCalls, label: "protected" }),
    });
    expect(late.work.claimNext(lateController.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await Promise.resolve();
    expect(lateCalls).toContain("pause");
    expect(lateCalls).not.toContain("ordinary:authority");
  });

  test("Fallback releases a waiting protected question and restarts its whole ordinary attempt", async () => {
    const selected = claim("fallback-waiting", "organization");
    const calls: string[] = [];
    let completed: Parameters<DurableSleepWorkPort["complete"]>[0] | undefined;
    const durable = workPort({
      calls,
      next: async () => ({
        status: "claimed",
        claim: selected,
        executionRepresentation: "protected",
        maximumStage: "organization",
      }),
    });
    durable.complete = async operation => {
      completed = operation;
      calls.push("complete");
      return {status: "accepted"};
    };
    const ordinary = semanticPort({calls, label: "ordinary", includeAttempt: true});
    const protectedSemantic = semanticPort({calls, label: "protected", includeAttempt: true});
    protectedSemantic.loadOrganizerView = async () => {
      calls.push("protected:view");
      return {status: "waiting", retryAt: 1_000};
    };
    const ports = bindReflectionSemanticDataOperationPort({
      policy: policyBinding({policy: POLICIES.fallback, calls}),
      work: durable,
      ordinary,
      protected: {
        ensureAuthority: protectedSemantic.ensureAuthority.bind(protectedSemantic),
        semantic: protectedSemantic,
        releaseWaitingSemantic: async (_claim, stage, failure) => {
          calls.push(`release:${stage}:${failure ?? "waiting"}`);
          return true;
        },
      },
    });

    await ports.work.claimNext();
    const attempt = await ports.semantic.openOrganizationAttempt!(selected);
    expect(await ports.semantic.loadOrganizerView(selected)).toEqual({
      status: "no_change",
      reason: "already_covered",
    });
    expect(await ports.semantic.ensureAuthority(selected)).toEqual({status: "ready"});
    expect(await ports.semantic.ensureSearchProjection(selected)).toEqual({status: "ready"});
    expect(await ports.semantic.invokeOrganizer(selected, "prompt")).toBe("proposal");
    expect(await ports.semantic.applyProposal({
      claim: selected,
      proposal: {operation: "no_change"},
      idempotencyKey: "apply",
      budget: HIERARCHY_BUDGET,
    })).toEqual({status: "unavailable", failureCode: "publication_unavailable"});
    expect(await attempt.publish(async () => "published")).toBe("published");
    await attempt.close("unavailable");
    await ports.work.complete({claim: selected});

    expect(calls.filter(value => value === "protected:attempt-close")).toHaveLength(1);
    expect(calls.filter(value => value === "ordinary:open-attempt")).toHaveLength(1);
    expect(calls).toContain("release:organization:waiting");
    for (const operation of [
      "ordinary:view",
      "ordinary:authority",
      "ordinary:search",
      "ordinary:organizer",
      "ordinary:apply",
      "ordinary:attempt-publish",
      "ordinary:attempt-close",
    ]) expect(calls).toContain(operation);
    expect(completed).toEqual({
      claim: selected,
      ordinaryFallbackReason: "key_waiting",
    });
  });

  test.each([
    "recoverable_availability",
    "key_waiting",
  ] as const)("Fallback admits a proven pre-execution %s failure", async failureClass => {
    const selected = claim(`fallback-${failureClass}`, "organization");
    const calls: string[] = [];
    let completed: Parameters<DurableSleepWorkPort["complete"]>[0] | undefined;
    const durable = workPort({next: async () => ({
      status: "claimed",
      claim: selected,
      executionRepresentation: "protected",
      maximumStage: "organization",
    })});
    durable.complete = operation => {
      completed = operation;
      return Promise.resolve({status: "accepted"});
    };
    const protectedSemantic = semanticPort({calls, label: "protected"});
    protectedSemantic.loadOrganizerView = async () => {
      calls.push("protected:view");
      throw new ClassifiedDataOperationError(failureClass, "pre-execution failure");
    };
    const ports = bindReflectionSemanticDataOperationPort({
      policy: policyBinding({policy: POLICIES.fallback}),
      work: durable,
      ordinary: semanticPort({calls, label: "ordinary"}),
      protected: {
        ensureAuthority: protectedSemantic.ensureAuthority.bind(protectedSemantic),
        semantic: protectedSemantic,
        releaseWaitingSemantic: async (_claim, stage, failure) => {
          calls.push(`release:${stage}:${failure}`);
          return true;
        },
      },
    });

    await ports.work.claimNext();
    expect(await ports.semantic.loadOrganizerView(selected)).toEqual({
      status: "no_change",
      reason: "already_covered",
    });
    await ports.work.complete({claim: selected});
    expect(calls).toContain(`release:organization:${failureClass}`);
    expect(calls).toContain("ordinary:view");
    expect(completed).toEqual({claim: selected, ordinaryFallbackReason: failureClass});
  });

  test.each(["strict", "full"] as const)(
    "%s never falls back from protected waiting",
    async policyName => {
      const selected = claim(`${policyName}-waiting`, "organization");
      const calls: string[] = [];
      const protectedSemantic = semanticPort({calls, label: "protected"});
      protectedSemantic.loadOrganizerView = async () => {
        calls.push("protected:view");
        return {status: "waiting", retryAt: 1_000};
      };
      const ports = bindReflectionSemanticDataOperationPort({
        policy: policyBinding({policy: POLICIES[policyName]}),
        work: workPort({next: async () => ({
          status: "claimed",
          claim: selected,
          executionRepresentation: "protected",
          maximumStage: "organization",
        })}),
        ordinary: semanticPort({calls, label: "ordinary"}),
        protected: {
          ensureAuthority: protectedSemantic.ensureAuthority.bind(protectedSemantic),
          semantic: protectedSemantic,
          releaseWaitingSemantic: async () => {
            calls.push("release");
            return true;
          },
        },
      });

      await ports.work.claimNext();
      expect(await ports.semantic.loadOrganizerView(selected)).toEqual({
        status: "waiting",
        retryAt: 1_000,
      });
      expect(calls).not.toContain("release");
      expect(calls).not.toContain("ordinary:view");
    },
  );

  test.each([
    "unknown",
    "integrity",
    "authority",
    "stale",
    "unsupported",
    "cancelled",
  ] as const)("Fallback rejects the non-availability failure class %s", async failureClass => {
    const selected = claim(`fallback-denied-${failureClass}`, "organization");
    const calls: string[] = [];
    const protectedSemantic = semanticPort({calls, label: "protected"});
    protectedSemantic.loadOrganizerView = async () => {
      calls.push("protected:view");
      throw new ClassifiedDataOperationError(failureClass, "fail closed");
    };
    const ports = bindReflectionSemanticDataOperationPort({
      policy: policyBinding({policy: POLICIES.fallback}),
      work: workPort({next: async () => ({
        status: "claimed",
        claim: selected,
        executionRepresentation: "protected",
        maximumStage: "organization",
      })}),
      ordinary: semanticPort({calls, label: "ordinary"}),
      protected: {
        ensureAuthority: protectedSemantic.ensureAuthority.bind(protectedSemantic),
        semantic: protectedSemantic,
        releaseWaitingSemantic: async () => {
          calls.push("release");
          return true;
        },
      },
    });

    await ports.work.claimNext();
    expect(ports.semantic.loadOrganizerView(selected)).rejects.toMatchObject({failureClass});
    await Promise.resolve();
    expect(calls).not.toContain("release");
    expect(calls).not.toContain("ordinary:view");
  });

  test("Fallback requires a successful release proof and never switches after preparation", async () => {
    const rejected = claim("release-rejected", "organization");
    const prepared = claim("already-prepared", "organization");
    const calls: string[] = [];
    const queue = [rejected, prepared];
    const protectedSemantic = semanticPort({calls, label: "protected"});
    protectedSemantic.loadOrganizerView = async current => {
      calls.push(`protected:view:${current.recordRef}`);
      if (current === rejected) {
        throw new ClassifiedDataOperationError("key_waiting", "key unavailable");
      }
      return {status: "ready", view: {
        changed: {
          handle: "R1",
          dependency: {kind: "record", recordRef: current.recordRef},
          snapshot: {
            recordRef: current.recordRef,
            observedContentFingerprint: current.recordRef,
            posture: "authored",
            anchors: [current.recordRef],
            statement: "Prepared evidence",
            sourceRefs: [],
            childRecordRefs: [],
            structuralHeight: 0,
            lifecycle: "current",
          },
        },
        candidates: [],
        existingParents: [],
        maxSelectedChildren: 2,
      }};
    };
    protectedSemantic.invokeOrganizer = async () => {
      calls.push("protected:organizer");
      throw new ClassifiedDataOperationError(
        "recoverable_availability",
        "provider unavailable after preparation",
      );
    };
    const ports = bindReflectionSemanticDataOperationPort({
      policy: policyBinding({policy: POLICIES.fallback}),
      work: workPort({next: async () => ({
        status: "claimed",
        claim: queue.shift()!,
        executionRepresentation: "protected",
        maximumStage: "organization",
      })}),
      ordinary: semanticPort({calls, label: "ordinary"}),
      protected: {
        ensureAuthority: protectedSemantic.ensureAuthority.bind(protectedSemantic),
        semantic: protectedSemantic,
        releaseWaitingSemantic: async () => {
          calls.push("release");
          return false;
        },
      },
    });

    await ports.work.claimNext();
    await ports.work.claimNext();
    expect(ports.semantic.loadOrganizerView(rejected)).rejects.toMatchObject({
      failureClass: "key_waiting",
    });
    expect(await ports.semantic.loadOrganizerView(prepared)).toMatchObject({status: "ready"});
    expect(ports.semantic.invokeOrganizer(prepared, "prompt")).rejects.toMatchObject({
      failureClass: "recoverable_availability",
    });
    await Promise.resolve();
    expect(calls.filter(value => value === "release")).toHaveLength(1);
    expect(calls.filter(value => value.startsWith("ordinary:"))).toEqual([]);
  });

  test("Plain execution never invokes the protected fallback release callback", async () => {
    const selected = claim("plain-no-fallback", "organization");
    const calls: string[] = [];
    const ports = bindReflectionSemanticDataOperationPort({
      policy: policyBinding({policy: POLICIES.plain}),
      work: workPort({next: async () => ({
        status: "claimed",
        claim: selected,
        executionRepresentation: "ordinary",
        maximumStage: "organization",
      })}),
      ordinary: semanticPort({calls, label: "ordinary"}),
      protected: {
        ...semanticPort({calls, label: "protected"}),
        releaseWaitingSemantic: async () => {
          calls.push("release");
          return true;
        },
      },
    });

    await ports.work.claimNext();
    expect(await ports.semantic.loadOrganizerView(selected)).toEqual({
      status: "no_change",
      reason: "already_covered",
    });
    expect(calls).toEqual(["ordinary:view"]);
  });

  test("delegated work methods retain their owning this binding", async () => {
    const calls: string[] = [];
    const selected = claim("delegated");
    const ports = bindReflectionSemanticDataOperationPort({
      policy: policyBinding({ policy: POLICIES.plain }),
      work: workPort({ calls, next: async () => ({
        status: "claimed",
        claim: selected,
        executionRepresentation: "ordinary",
        maximumStage: "organization",
      }) }),
      ordinary: semanticPort({ calls, label: "ordinary" }),
      protected: semanticPort({ calls, label: "protected" }),
    });
    await ports.work.claimNext();
    calls.length = 0;
    await ports.work.checkpoint({
      claim: selected,
      completedStage: "authority_projection",
    });
    await ports.work.pause({ claim: selected });
    await ports.work.complete({ claim: selected });
    await ports.work.defer({
      claim: selected,
      failureCode: "unexpected_failure",
    });
    await ports.work.enqueue({
      logicalObjectRef: "record",
      generation: 1,
      recordRef: "record",
      changeReason: "created",
    });
    expect(calls).toEqual([
      "checkpoint",
      "pause",
      "complete",
      "defer",
      "enqueue",
    ]);
  });
});
