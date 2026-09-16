import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  BROWSER_CONTRACT_SCHEMAS,
  COMPUTER_USE_BROWSER_CONTRACTS,
  browserMutationResultSchema,
  computerBrowserElementReferenceSchema,
  computerBrowserTabReferenceSchema,
  computerBrowserTargetReferenceSchema,
  computerBrowserFailureSchema,
} from "../../src/index.ts";
import {
  computeComputerUseSchemaDigest,
  stringifyCanonicalComputerUseSchemaJson,
} from "../../src/schema-digest.ts";

const opaque = (prefix: string, fill: string) => `${prefix}_${fill.repeat(43)}`;

describe("browser Computer Use contracts", () => {
  test("failure explanations are closed and cannot carry private provider diagnostics", () => {
    const failure = {
      reason: "setup_control_ambiguous", stage: "prepare", stateChangeCertainty: "not_changed",
      retryCondition: "route_or_provider_change",
    };
    expect(computerBrowserFailureSchema.safeParse(failure).success).toBe(true);
    expect(computerBrowserFailureSchema.safeParse({ ...failure, message: "private AX content" }).success).toBe(false);
    expect(computerBrowserFailureSchema.safeParse({ ...failure, reason: "arbitrary-provider-message" }).success).toBe(false);
    expect(BROWSER_CONTRACT_SCHEMAS.prepare.result.safeParse({
      status: "recovery_required", recovery: "use_native_window", observeAgain: true, doNotReplay: true, failure,
    }).success).toBe(true);
  });

  test("descriptor digests bind the canonical input and result JSON schemas", () => {
    for (const key of Object.keys(BROWSER_CONTRACT_SCHEMAS) as Array<keyof typeof BROWSER_CONTRACT_SCHEMAS>) {
      const schemas = BROWSER_CONTRACT_SCHEMAS[key];
      const canonical = stringifyCanonicalComputerUseSchemaJson({
        input: z.toJSONSchema(schemas.input),
        result: z.toJSONSchema(schemas.result),
      });
      const independentlyComputed = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
      expect(String(COMPUTER_USE_BROWSER_CONTRACTS[key].schemaDigest)).toBe(independentlyComputed);
      expect(String(computeComputerUseSchemaDigest(schemas.input, schemas.result))).toBe(independentlyComputed);
    }
  });

  test("action recovery exposes only reviewed route and escalation enums", () => {
    const failure = { reason: "route_unavailable", stage: "action", stateChangeCertainty: "not_changed",
      retryCondition: "route_or_provider_change", inputRoute: "trusted",
      escalation: { target: "foreground", reason: "route_unavailable" } };
    expect(computerBrowserFailureSchema.safeParse(failure).success).toBe(true);
    expect(computerBrowserFailureSchema.safeParse({ ...failure, inputRoute: "private-route" }).success).toBe(false);
    expect(computerBrowserFailureSchema.safeParse({ ...failure,
      escalation: { ...failure.escalation, message: "private diagnostic" } }).success).toBe(false);
  });

  test("opaque browser references are context-bound and non-substitutable", () => {
    const context = opaque("dbctx", "a");
    const target = { version: 1, context, reference: opaque("dbtgt", "b") } as const;
    const tab = { version: 1, context, reference: opaque("dbtab", "c") } as const;
    const element = { version: 1, context, reference: opaque("dbref", "d") } as const;
    expect(computerBrowserTargetReferenceSchema.parse(target)).toEqual(target);
    expect(computerBrowserTabReferenceSchema.parse(tab)).toEqual(tab);
    expect(computerBrowserElementReferenceSchema.parse(element)).toEqual(element);
    expect(computerBrowserTabReferenceSchema.safeParse(target).success).toBe(false);
    expect(computerBrowserElementReferenceSchema.safeParse({ ...element, pid: 42 }).success).toBe(false);
  });

  test("public observations reject Cua-native identity and stale continuation combinations", () => {
    const context = opaque("dbctx", "a");
    const target = { version: 1, context, reference: opaque("dbtgt", "b") };
    const tab = { version: 1, context, reference: opaque("dbtab", "c") };
    const continuation = { version: 1, context, reference: opaque("dbcont", "d") };
    expect(BROWSER_CONTRACT_SCHEMAS.readPage.input.safeParse({ target, tab, continuation, query: "needle" }).success).toBe(false);
    expect(BROWSER_CONTRACT_SCHEMAS.readPage.result.safeParse({
      status: "observed", target, tab,
      page: { title: "Fixture", url: "http://127.0.0.1/" },
      outline: "Fixture",
      refs: [],
      snapshot: { complete: true, omitted: { cssHidden: 0, offscreen: 0, pageOccluded: 0, noLayout: 0, unknown: 0, budget: 0, unprovableFrame: 0 }, continuation: null },
      target_id: "provider-private",
    }).success).toBe(false);
  });

  test("every mutation settlement requires fresh observation and prohibits replay", () => {
    for (const status of ["delivered", "not_delivered", "unknown_completion"] as const) {
      const value = status === "not_delivered"
        ? { status, observeAgain: true, doNotReplay: true, recovery: "observe_again" }
        : { status, observeAgain: true, doNotReplay: true };
      expect(browserMutationResultSchema.safeParse(value).success).toBe(true);
      expect(browserMutationResultSchema.safeParse({ ...value, observeAgain: false }).success).toBe(false);
      expect(browserMutationResultSchema.safeParse({ ...value, doNotReplay: false }).success).toBe(false);
    }
  });
});
