import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_CONTRACT_SCHEMAS,
  COMPUTER_USE_BROWSER_CONTRACTS,
} from "@nautilo/computer-use-contracts";
import {
  computeComputerUseJsonSchemaDigest,
  computeComputerUseSchemaDigest,
} from "@nautilo/computer-use-contracts/schema-digest";
import {
  COMPUTER_USE_NATIVE_CONTRACTS,
  NATIVE_CONTRACT_SCHEMAS,
} from "@nautilo/computer-use-contracts/native";
import {
  bundledComputerUseContractCatalogue,
  projectComputerUseContractCatalogue,
} from "../../src/config/computer-use-catalogue/catalog";
import {
  activeComputerUseHostToolDefinitions,
  resolveComputerUseHostToolRequest,
} from "../../src/config/computer-use-catalogue/host-tool-admission";
import {
  configureRuntimeComputerUseContractCatalogue,
  getActiveComputerUseContractCatalogueResultSync,
  refreshRuntimeComputerUseContractCatalogue,
  resetRuntimeComputerUseContractCatalogue,
  startRuntimeComputerUseContractCatalogueRefreshLoop,
  stopRuntimeComputerUseContractCatalogueRefreshLoop,
} from "../../src/config/computer-use-catalogue/runtime-catalogue";
import {
  bundledComputerUseContractCatalogueArtifactSha256,
  createRemoteComputerUseContractCatalogueLoader,
} from "../../src/config/computer-use-catalogue/remote-catalogue";
import { createComputerHostContractTool } from "../../src/tools/computer/computer-host-contract";
import {
  canonicalComputerUseContractCatalogueSigningPayloadV1,
  compareComputerUseContractCatalogueVersionV1,
  computerUseContractCatalogueEntrySchema,
  computerUseContractCatalogueSnapshotV1Schema,
  computerUseContractCatalogueV1Schema,
  immutableComputerUseContractCatalogueFilenameV1,
} from "../../src/config/computer-use-catalogue/schema";
import { ComputerUseHost } from "../../../computer-use-host/src/runtime";

test("native editing guidance covers whole filenames, scope recovery, and committed postconditions", () => {
  const guidance = bundledComputerUseContractCatalogue.modelGuidance;
  expect(guidance).toContain("only the intended file is selected");
  expect(guidance).toContain("including the extension");
  expect(guidance).toContain("An edited draft is not a committed rename");
  expect(guidance).toContain("targetCondition unavailable");
  expect(guidance).toContain("supported pixel/desktop route");
  expect(guidance).toContain("Never remove window identity checks");
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function laterCatalogueVersion(offset: number): string {
  const match = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/u.exec(bundledComputerUseContractCatalogue.catalogueVersion);
  if (match === null) throw new Error("bundled catalogue version fixture rejected");
  return `${match[1]}.${Number(match[2]) + offset}`;
}

function laterPublishedAt(offsetHours: number): string {
  return new Date(Date.parse(bundledComputerUseContractCatalogue.publishedAt) + offsetHours * 60 * 60 * 1_000).toISOString();
}

function signedFixture(
  catalogueVersion = laterCatalogueVersion(1),
  publishedAt = laterPublishedAt(1),
  mutate?: (snapshot: Record<string, unknown>) => void,
  signing?: Readonly<{ publicKey: KeyObject; privateKey: KeyObject }>,
) {
  const keys = signing ?? generateKeyPairSync("ed25519");
  const snapshot: Record<string, unknown> = {
    ...(JSON.parse(JSON.stringify(bundledComputerUseContractCatalogue)) as Record<string, unknown>),
    catalogueVersion,
    publishedAt,
  };
  delete snapshot["provenance"];
  mutate?.(snapshot);
  return signedSnapshot(snapshot, catalogueVersion, keys);
}

function signedSnapshot(
  snapshot: Record<string, unknown>,
  pointerVersion: string,
  keys: Readonly<{ publicKey: KeyObject; privateKey: KeyObject }>,
) {
  const artifactText = JSON.stringify(snapshot);
  const artifactSha256 = createHash("sha256").update(artifactText).digest("hex");
  const pointer = {
    catalogueVersion: pointerVersion,
    artifactSha256,
    signingKeyId: "test",
    signature: sign(
      null,
      Buffer.from(canonicalComputerUseContractCatalogueSigningPayloadV1(
        pointerVersion,
        artifactSha256,
      )),
      keys.privateKey,
    ).toString("base64"),
  };
  return {
    snapshot,
    pointer,
    artifactText,
    signing: keys,
    publicKeyDer: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

function releaseFetch(pointer: unknown, artifact: unknown, urls: string[] = []): typeof fetch {
  let request = 0;
  return (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url);
    return json(request++ === 0 ? pointer : artifact);
  }) as unknown as typeof fetch;
}

function loaderFor(
  fixture: ReturnType<typeof signedFixture>,
  fetchImpl = releaseFetch(fixture.pointer, fixture.snapshot),
) {
  return createRemoteComputerUseContractCatalogueLoader({
    pointerUrl: "https://catalogue.example.test/latest.json",
    allowedHosts: ["catalogue.example.test"],
    trustedKeys: { test: fixture.publicKeyDer },
    fetchImpl,
  });
}

test("bundled catalogue exactly binds Host descriptors, public schemas, classification provenance, and compact projection", () => {
  expect(computerUseContractCatalogueV1Schema.parse(bundledComputerUseContractCatalogue))
    .toEqual(bundledComputerUseContractCatalogue);
  expect(bundledComputerUseContractCatalogue.contracts.map((entry) => entry.descriptor))
    .toEqual([
      COMPUTER_USE_BROWSER_CONTRACTS.bindWindow,
      COMPUTER_USE_BROWSER_CONTRACTS.click,
      COMPUTER_USE_BROWSER_CONTRACTS.navigate,
      COMPUTER_USE_BROWSER_CONTRACTS.openUrl,
      COMPUTER_USE_BROWSER_CONTRACTS.pointer,
      COMPUTER_USE_BROWSER_CONTRACTS.prepare,
      COMPUTER_USE_BROWSER_CONTRACTS.readPage,
      COMPUTER_USE_BROWSER_CONTRACTS.type,
      COMPUTER_USE_NATIVE_CONTRACTS.do,
      COMPUTER_USE_NATIVE_CONTRACTS.observe,
      COMPUTER_USE_NATIVE_CONTRACTS.verify,
    ]);
  for (const entry of bundledComputerUseContractCatalogue.contracts) {
    expect(entry.publicSchemas.input.schemaId).toBe(
      `${entry.descriptor.contractNamespace}.${entry.descriptor.contractId}.input`,
    );
    expect(entry.publicSchemas.result.schemaId).toBe(
      `${entry.descriptor.contractNamespace}.${entry.descriptor.contractId}.result`,
    );
    expect(entry.publicSchemas.input.jsonSchema).toBeTypeOf("object");
    expect(entry.publicSchemas.result.jsonSchema).toBeTypeOf("object");
    expect(String(computeComputerUseJsonSchemaDigest(
      entry.publicSchemas.input.jsonSchema,
      entry.publicSchemas.result.jsonSchema,
    ))).toBe(entry.descriptor.schemaDigest);
    expect(entry.classificationProvenance).toEqual({
      reviewedSchemaDigest: entry.descriptor.schemaDigest,
      effectClass: "server_reviewed",
      replayClass: "server_reviewed",
      authorityClass: "server_reviewed",
      attachmentClass: "server_reviewed",
      disclosureClass: "server_reviewed",
    });
  }

  const projection = projectComputerUseContractCatalogue(bundledComputerUseContractCatalogue);
  expect(projection.contracts).toHaveLength(11);
  expect(projection.contracts.some((contract) => contract.contractId === "browser.dialog")).toBe(false);
  expect(projection.contracts[0]).toEqual({
    contractId: "browser.bind_window",
    contractVersion: 3,
    label: "Bind browser window",
    summary: "Bind one exact native browser window to a browser automation context.",
    effectClass: "read",
    replayClass: "safe",
    disclosureClass: "semantic",
  });
  expect(JSON.stringify(projection)).not.toMatch(/schema|digest|provenance|argumentsSummary|resultSummary/iu);
});

test("v1 compatibility accepts an older signed snapshot without guidance or scheduling metadata", () => {
  const oldSnapshot = JSON.parse(JSON.stringify(bundledComputerUseContractCatalogue)) as Record<string, unknown>;
  delete oldSnapshot["modelGuidance"];
  delete oldSnapshot["provenance"];
  for (const entry of oldSnapshot["contracts"] as Array<Record<string, unknown>>) {
    delete entry["scheduling"];
  }

  const parsed = computerUseContractCatalogueSnapshotV1Schema.parse(oldSnapshot);
  expect(parsed.modelGuidance).toBeUndefined();
  expect(parsed.contracts).toHaveLength(bundledComputerUseContractCatalogue.contracts.length);
  expect(parsed.contracts.every((entry) => entry.scheduling === undefined)).toBe(true);
});

test("only exact reviewed read-safe Host descriptors opt into coordinated scheduling", async () => {
  const scheduled = bundledComputerUseContractCatalogue.contracts
    .filter((entry) => entry.scheduling?.readConcurrency === "host_coordinated");
  expect(scheduled.map((entry) => entry.descriptor.contractId)).toEqual([
    "browser.read_page",
    "native.observe",
  ]);
  expect(scheduled.map((entry) => ({
    contractId: entry.descriptor.contractId,
    contractVersion: entry.descriptor.contractVersion,
    executionLane: entry.executionLane,
    effectClass: entry.descriptor.effectClass,
    replayClass: entry.descriptor.replayClass,
  }))).toEqual([
    { contractId: "browser.read_page", contractVersion: 5, executionLane: "host", effectClass: "read", replayClass: "safe" },
    { contractId: "native.observe", contractVersion: 9, executionLane: "host", effectClass: "read", replayClass: "safe" },
  ]);

  let executions = 0;
  const current = COMPUTER_USE_NATIVE_CONTRACTS.observe;
  const host = new ComputerUseHost({
    hostGeneration: "host-generation-catalogue",
    driverGeneration: "driver-generation-catalogue",
    handlers: [{
      contract: current,
      async execute() {
        executions += 1;
        return { settlement: "completed", result: { fixture: true } };
      },
    }],
  });
  const response = await host.dispatch({
    kind: "request",
    protocol: { major: 3, minor: 0 },
    requestId: "request-old-native-observe",
    authority: { authorityLeaseId: "lease-catalogue", authorityGeneration: 1 },
    fence: {
      hostGeneration: "host-generation-catalogue",
      driverGeneration: "driver-generation-catalogue",
      cancellationGeneration: 1,
    },
    contract: { ...current, contractVersion: current.contractVersion - 1 },
    arguments: { operation: "desktop_state" },
  });
  expect(response).toMatchObject({ settlement: "fenced", result: { reason: "unsupported_contract" } });
  expect(executions).toBe(0);
});

test("coordinated scheduling metadata is strict and limited to Host read-safe entries", () => {
  const observe = bundledComputerUseContractCatalogue.contracts
    .find((entry) => entry.descriptor.contractId === "native.observe");
  if (observe === undefined) throw new Error("missing native.observe");
  expect(computerUseContractCatalogueEntrySchema.parse(observe).scheduling)
    .toEqual({ readConcurrency: "host_coordinated" });

  const invalid = [
    { ...observe, descriptor: { ...observe.descriptor, effectClass: "mutate" } },
    { ...observe, descriptor: { ...observe.descriptor, replayClass: "at_most_once" } },
    { ...observe, executionLane: "legacy_native" },
    { ...observe, scheduling: { readConcurrency: "legacy_lane" } },
    { ...observe, scheduling: { readConcurrency: "host_coordinated", unknown: true } },
    { ...observe, unknown: true },
  ];
  for (const entry of invalid) {
    expect(computerUseContractCatalogueEntrySchema.safeParse(entry).success).toBe(false);
  }
});

test("the active signed catalogue projects Host tools declaratively as exact descriptor-plus-validated JSON", () => {
  const definitions = activeComputerUseHostToolDefinitions();
  expect(definitions).toHaveLength(11);
  expect(definitions.some((definition) => definition.entry.descriptor.contractId === "browser.dialog")).toBe(false);
  const navigate = definitions.find((definition) => definition.entry.descriptor.contractId === "browser.navigate")!;
  const request = resolveComputerUseHostToolRequest(navigate.name, {
    target: { version: 1, context: `dbctx_${"a".repeat(43)}`, reference: `dbtgt_${"b".repeat(43)}` },
    tab: { version: 1, context: `dbctx_${"a".repeat(43)}`, reference: `dbtab_${"c".repeat(43)}` },
    url: "https://example.test/",
  });
  expect(request).toEqual({
    contract: COMPUTER_USE_BROWSER_CONTRACTS.navigate,
    arguments: {
      target: { version: 1, context: `dbctx_${"a".repeat(43)}`, reference: `dbtgt_${"b".repeat(43)}` },
      tab: { version: 1, context: `dbctx_${"a".repeat(43)}`, reference: `dbtab_${"c".repeat(43)}` },
      url: "https://example.test/",
    },
  });
  expect(resolveComputerUseHostToolRequest(navigate.name, { url: "file:///private" })).toBeNull();
  expect(computerUseContractCatalogueV1Schema.safeParse(bundledComputerUseContractCatalogue).success)
    .toBe(true);
});

test("model tool schemas omit only provider-incompatible Unicode regex without weakening signed server admission", () => {
  const definition = activeComputerUseHostToolDefinitions()
    .find((candidate) => candidate.entry.descriptor.contractId === "native.do");
  if (definition === undefined) throw new Error("missing native.do");

  const publishedSchema = JSON.stringify(definition.entry.publicSchemas.input.jsonSchema);
  const modelSchema = JSON.stringify(createComputerHostContractTool(definition.name).schema);
  expect(publishedSchema).toContain("\\\\p{Cc}");
  expect(modelSchema).not.toContain("\\\\p{Cc}");
  expect(modelSchema).toContain("^dctx_");

  expect(resolveComputerUseHostToolRequest(definition.name, {
    operation: { kind: "launch_app", app: { name: "Text\u0000Edit" } },
  })).toBeNull();
});

test("published input JSON and Host Zod agree on the cross-field differential corpus", () => {
  const opaque = (prefix: string, fill: string) => `${prefix}${fill.repeat(43)}`;
  const nativeContext = opaque("dctx_", "a");
  const window = { version: 1, context: nativeContext, reference: opaque("dtgt_", "b") };
  const browserContext = opaque("dbctx_", "c");
  const browserTarget = { version: 1, context: browserContext, reference: opaque("dbtgt_", "d") };
  const browserTab = { version: 1, context: browserContext, reference: opaque("dbtab_", "e") };
  const browserScope = { version: 1, context: browserContext, reference: opaque("dbcontent_", "f") };
  const browserContinuation = { version: 1, context: browserContext, reference: opaque("dbcont_", "g") };
  const browserElement = { version: 1, context: browserContext, reference: opaque("dbref_", "h") };
  const schemas = {
    "native.observe": NATIVE_CONTRACT_SCHEMAS.observe.input,
    "native.do": NATIVE_CONTRACT_SCHEMAS.do.input,
    "native.verify": NATIVE_CONTRACT_SCHEMAS.verify.input,
    "browser.read_page": BROWSER_CONTRACT_SCHEMAS.readPage.input,
    "browser.navigate": BROWSER_CONTRACT_SCHEMAS.navigate.input,
    "browser.open_url": BROWSER_CONTRACT_SCHEMAS.openUrl.input,
    "browser.pointer": BROWSER_CONTRACT_SCHEMAS.pointer.input,
  } as const;
  const invalidCases = [
    ["native.observe", { operation: "window_state", target: window, selector: { role: "row", action: "run_shell" } }],
    ["native.do", { operation: { kind: "launch_app", app: { name: "/Applications/TextEdit.app" } } }],
    ["native.do", { operation: { kind: "launch_app", app: { name: "Text\u0000Edit" } } }],
    ["native.do", { operation: { kind: "invoke_menu", target: window, menuPath: [" File "] } }],
    ["native.verify", { target: window, expect: [{ window: {} }] }],
    ["native.verify", { target: window, expect: [{ element: { selector: {} } }] }],
    ["native.verify", { target: window, expect: [{ window: { exists: true }, element: { selector: { role: "button" }, exists: true } }] }],
    ["native.verify", { target: window, expect: [{ element: { selector: { role: " " }, exists: true } }] }],
    ["browser.read_page", { target: browserTarget, tab: browserTab, continuation: browserContinuation, query: "Kyushu" }],
    ["browser.read_page", { target: browserTarget, tab: browserTab, continuation: browserContinuation, scope: browserScope }],
    ["browser.navigate", { target: browserTarget, tab: browserTab, url: "file:///tmp/private" }],
    ["browser.navigate", { target: browserTarget, tab: browserTab, url: "https://" }],
    ["browser.open_url", { target: browserTarget, url: "javascript:alert(1)" }],
    ["browser.pointer", { target: browserTarget, tab: browserTab, element: browserElement, inputRoute: "trusted", action: "scroll", deltaX: 0, deltaY: 0 }],
  ] as const;
  for (const [contractId, value] of invalidCases) {
    const definition = activeComputerUseHostToolDefinitions().find((candidate) => candidate.entry.descriptor.contractId === contractId);
    if (definition === undefined) throw new Error(`missing ${contractId}`);
    expect({
      published: resolveComputerUseHostToolRequest(definition.name, value) !== null,
      host: schemas[contractId].safeParse(value).success,
    }).toEqual({ published: false, host: false });
  }

  // Alias duplicates are deliberately accepted by both public validators;
  // Host canonicalizes alt -> option and deduplicates before Cua dispatch.
  const duplicateModifiers = { operation: { kind: "press_key", target: window, key: "x", modifiers: ["alt", "option"] } };
  const nativeDo = activeComputerUseHostToolDefinitions().find((candidate) => candidate.entry.descriptor.contractId === "native.do");
  if (nativeDo === undefined) throw new Error("missing native.do");
  expect({
    published: resolveComputerUseHostToolRequest(nativeDo.name, duplicateModifiers) !== null,
    host: NATIVE_CONTRACT_SCHEMAS.do.input.safeParse(duplicateModifiers).success,
  }).toEqual({ published: true, host: true });
});

test("published native observation schema preserves exact traversal effort and rejects invalid effort", () => {
  const opaque = (prefix: string, fill: string) => `${prefix}${fill.repeat(43)}`;
  const context = opaque("dctx_", "a");
  const window = { version: 1, context, reference: opaque("dtgt_", "b") };
  const app = { version: 1, context, reference: opaque("datgt_", "c") };
  const definition = activeComputerUseHostToolDefinitions()
    .find((candidate) => candidate.entry.descriptor.contractId === "native.observe");
  if (definition === undefined) throw new Error("missing native.observe");
  const nativeObserveZod = NATIVE_CONTRACT_SCHEMAS.observe.input;

  const accepted = [
    { operation: "window_state", target: window, selector: { role: "checkbox", interaction: "double_click" } },
    { operation: "window_state", target: window, selector: { role: "row", action: "click" } },
    { operation: "window_state", target: window, selector: { role: "text_field", action: "type_text", labelEquals: "Existing editor" } },
    { operation: "window_state", target: window, selector: { role: "popup_button", action: "set_value", labelEquals: "Format" } },
    { operation: "window_state", target: window, selector: { role: "outline", action: "scroll" } },
    { operation: "window_state", target: window, selector: { role: "future_control", action: "click", interaction: "right_click" } },
    { operation: "window_state", target: window, selector: { role: "link", action: "click", interaction: "double_click", labelEquals: "Needle" }, query: "Needle" },
    { operation: "window_state", target: window },
    { operation: "window_state", target: window, effort: { maxElements: 4_000 } },
    { operation: "window_state", target: window, selector: { role: "button" }, effort: { maxDepth: 40 } },
    { operation: "window_state", target: window, capture: "window_snapshot", effort: { maxElements: 5_000, maxDepth: 50 } },
    { operation: "window_state", target: window, query: "Needle", effort: { maxElements: 6_000 } },
    {
      operation: "window_state", target: window, query: "Needle",
      selector: { role: "button" }, capture: "window_snapshot",
      effort: { maxElements: 6_000, maxDepth: 50 },
    },
    { operation: "application_windows", target: app, query: "Needle", effort: { maxElements: 7_000, maxDepth: 60 } },
  ] as const;
  for (const value of accepted) {
    const published = resolveComputerUseHostToolRequest(definition.name, value);
    expect(nativeObserveZod.safeParse(value).success).toBe(true);
    expect(published?.arguments).toEqual(value);
  }

  const rejected = [
    { operation: "window_state", target: window, effort: {} },
    { operation: "window_state", target: window, effort: { maxElements: 0 } },
    { operation: "window_state", target: window, effort: { maxDepth: -1 } },
    { operation: "window_state", target: window, effort: { maxElements: 1.5 } },
    { operation: "window_state", target: window, effort: { maxDepth: Number.MAX_SAFE_INTEGER + 1 } },
    { operation: "window_state", target: window, effort: { maxElements: 100, unknown: 1 } },
    {
      operation: "window_state", target: window, query: "Needle", selector: { role: "row", action: "click", element_token: "private-token" },
      capture: "window_snapshot", effort: { maxElements: 4_000 },
    },
    { operation: "application_windows", target: app, effort: { maxElements: 4_000 } },
  ] as const;
  for (const value of rejected) {
    expect({
      published: resolveComputerUseHostToolRequest(definition.name, value) !== null,
      host: nativeObserveZod.safeParse(value).success,
    }).toEqual({ published: false, host: false });
  }
});

test("published native pointer and AX action schema agrees with Host admission", () => {
  const context = `dctx_${"a".repeat(43)}`;
  const snapshot = { version: 1, context, reference: `dsnap_${"b".repeat(43)}` };
  const element = { version: 1, context, reference: `detgt_${"c".repeat(43)}` };
  const definition = activeComputerUseHostToolDefinitions().find((candidate) => candidate.entry.descriptor.contractId === "native.do");
  if (definition === undefined) throw new Error("missing native.do");
  expect(definition.entry.descriptor.contractVersion).toBe(12);
  const pixel = { kind: "click", target: snapshot, coordinateSpace: "window_snapshot_pixels", x: 10, y: 20 };
  const drag = { kind: "drag_drop", target: snapshot, coordinateSpace: "presented_snapshot_pixels", from: { x: 2, y: 3 }, to: { x: 20, y: 30 } };
  const accepted = [
    { kind: "hotkey", target: element, keys: ["command", "shift", "s"], deliveryMode: "foreground" },
    { kind: "hotkey", scope: "desktop", target: snapshot, keys: ["ctrl", "left"] },
    { kind: "hotkey", target: snapshot, coordinateSpace: "window_snapshot_pixels", x: 12, y: 24, keys: ["cmd", "v"] },
    ...["Z", "F12", "ENTER", "left_arrow", "=", "+", "]", "\\", "`"].map((key) => ({ kind: "press_key", target: element, key, modifiers: ["command"], deliveryMode: "foreground" })),
    { kind: "move_pointer", scope: "desktop", target: snapshot, coordinateSpace: "presented_snapshot_pixels", x: 12, y: 24 },
    { kind: "type_text", scope: "desktop", target: snapshot, text: "focused input", delayMs: 0 },
    { kind: "press_key", scope: "desktop", target: snapshot, key: "TAB", modifiers: ["command"] },
    { kind: "type_text", target: element, text: "paced input", delayMs: 200 },
    { kind: "type_text", target: element, text: "existing document", deliveryMode: "foreground" },
    { kind: "click", target: element, button: "right", modifiers: ["shift"], deliveryMode: "foreground" },
    { kind: "scroll", target: snapshot, coordinateSpace: "presented_snapshot_pixels", x: 10, y: 20, direction: "up", amount: 50, by: "page", deliveryMode: "foreground" },
    drag,
    ...[0, 500, 10_000].map((durationMs) => ({ ...drag, durationMs, steps: 200, button: "middle", modifiers: ["option"], deliveryMode: "foreground" })),
    { ...pixel, coordinateSpace: "presented_snapshot_pixels", deliveryMode: "background" },
    ...["press", "show_menu", "pick", "confirm", "cancel", "open"].map((axAction) => ({ kind: "click", target: element, axAction })),
    ...["left", "right", "middle"].flatMap((button) => ["window_snapshot_pixels", "presented_snapshot_pixels"].map((coordinateSpace) => ({
      ...pixel, coordinateSpace, button, count: 3, modifiers: ["cmd", "shift"], deliveryMode: "foreground",
    }))),
  ];
  const rejected = [
    { kind: "press_key", target: element, key: "invented_key" },
    ...[{ durationMs: -1 }, { durationMs: 10_001 }, { steps: 0 }, { steps: 201 }].map((invalid) => ({ ...drag, ...invalid })),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((count) => ({ ...pixel, count })),
    { ...pixel, button: "unknown" }, { ...pixel, modifiers: ["unknown"] },
    { ...pixel, deliveryMode: "unknown" },
    { kind: "click", target: element, axAction: "arbitrary_method" },
  ];
  for (const [operations, expected] of [[accepted, true], [rejected, false]] as const) {
    for (const operation of operations) {
      expect({
        host: NATIVE_CONTRACT_SCHEMAS.do.input.safeParse({ operation }).success,
        published: resolveComputerUseHostToolRequest(definition.name, { operation }) !== null,
      }).toEqual({ host: expected, published: expected });
    }
  }
});

test("schema digest has stable JSON-schema and Zod parity", () => {
  expect(computeComputerUseSchemaDigest(
    NATIVE_CONTRACT_SCHEMAS.observe.input,
    NATIVE_CONTRACT_SCHEMAS.observe.result,
  )).toBe(COMPUTER_USE_NATIVE_CONTRACTS.observe.schemaDigest);
  expect(computeComputerUseSchemaDigest(
    BROWSER_CONTRACT_SCHEMAS.bindWindow.input,
    BROWSER_CONTRACT_SCHEMAS.bindWindow.result,
  )).toBe(COMPUTER_USE_BROWSER_CONTRACTS.bindWindow.schemaDigest);
  expect(computeComputerUseJsonSchemaDigest(
    { type: "object", properties: { zero: { const: -0 }, ordered: { enum: ["b", "a"] } } },
    { required: ["ordered", "zero"], type: "object" },
  )).toBe("sha256:cee35a0a36681771280ffde762fd5df90b70d0433d83ac7e88375f1da57570d7");
  expect(computeComputerUseJsonSchemaDigest(
    { properties: { ordered: { enum: ["b", "a"] }, zero: { const: 0 } }, type: "object" },
    { type: "object", required: ["ordered", "zero"] },
  )).toBe("sha256:cee35a0a36681771280ffde762fd5df90b70d0433d83ac7e88375f1da57570d7");
});

test("a valid signed pointer fetches its exact digest-named immutable artifact", async () => {
  const fixture = signedFixture();
  const urls: string[] = [];
  const result = await loaderFor(
    fixture,
    releaseFetch(fixture.pointer, fixture.snapshot, urls),
  ).refresh();
  expect(result).toMatchObject({
    source: "remote-fresh",
    stale: false,
    catalogueVersion: fixture.pointer.catalogueVersion,
    artifactSha256: fixture.pointer.artifactSha256,
    reason: "verified computer use contract catalogue",
    catalogue: { provenance: "remote" },
  });
  expect(urls).toEqual([
    "https://catalogue.example.test/latest.json",
    `https://catalogue.example.test/${immutableComputerUseContractCatalogueFilenameV1(
      fixture.pointer.catalogueVersion,
      fixture.pointer.artifactSha256,
    )}`,
  ]);
});

test("a verified remote catalogue survives an offline restart as an explicit stale LKG", async () => {
  const fixture = signedFixture();
  const root = mkdtempSync(join(tmpdir(), "nautilo-computer-use-lkg-"));
  const lkgPath = join(root, "computer-use-contract-catalogue-lkg.json");
  const first = createRemoteComputerUseContractCatalogueLoader({
    pointerUrl: "https://catalogue.example.test/latest.json",
    allowedHosts: ["catalogue.example.test"],
    trustedKeys: { test: fixture.publicKeyDer },
    fetchImpl: releaseFetch(fixture.pointer, fixture.snapshot),
    lkgPath,
  });
  expect((await first.refresh()).source).toBe("remote-fresh");
  expect(readFileSync(lkgPath, "utf8")).toContain(fixture.pointer.artifactSha256);

  const offline = createRemoteComputerUseContractCatalogueLoader({
    pointerUrl: "https://catalogue.example.test/latest.json",
    allowedHosts: ["catalogue.example.test"],
    trustedKeys: { test: fixture.publicKeyDer },
    fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
    lkgPath,
  });
  expect(await offline.refresh()).toMatchObject({
    source: "remote-stale",
    stale: true,
    catalogueVersion: fixture.pointer.catalogueVersion,
    artifactSha256: fixture.pointer.artifactSha256,
    reason: "verified restart last-known-good catalogue",
  });
  expect((await offline.get()).source).toBe("remote-stale");

  writeFileSync(lkgPath, "{}\n");
  const corrupt = createRemoteComputerUseContractCatalogueLoader({
    pointerUrl: "https://catalogue.example.test/latest.json",
    allowedHosts: ["catalogue.example.test"],
    trustedKeys: { test: fixture.publicKeyDer },
    fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
    lkgPath,
  });
  expect((await corrupt.refresh()).source).toBe("bundled-fallback");
  rmSync(root, { recursive: true, force: true });
});

test("signature, immutable digest, pointer shape, and strict catalogue metadata failures never activate", async () => {
  const fixture = signedFixture();
  const contracts = fixture.snapshot["contracts"] as Array<Record<string, unknown>>;
  const first = contracts[0]!;
  const malformedSnapshots = [
    { ...fixture.snapshot, executablePath: "/private/bin" },
    { ...fixture.snapshot, contracts: [...contracts, first] },
    { ...fixture.snapshot, contracts: [...contracts].reverse() },
    {
      ...fixture.snapshot,
      contracts: [{
        ...first,
        publicSchemas: {
          ...(first["publicSchemas"] as Record<string, unknown>),
          input: { schemaId: "wrong.contract.input", schemaVersion: 1 },
        },
      }, ...contracts.slice(1)],
    },
    {
      ...fixture.snapshot,
      contracts: [{
        ...first,
        publicSchemas: {
          input: {
            ...((first["publicSchemas"] as Record<string, unknown>)["input"] as Record<string, unknown>),
            schemaId: `${((first["descriptor"] as Record<string, unknown>)["contractNamespace"] as string)}.${((first["descriptor"] as Record<string, unknown>)["contractId"] as string)}.result`,
          },
          result: {
            ...((first["publicSchemas"] as Record<string, unknown>)["result"] as Record<string, unknown>),
            schemaId: `${((first["descriptor"] as Record<string, unknown>)["contractNamespace"] as string)}.${((first["descriptor"] as Record<string, unknown>)["contractId"] as string)}.input`,
          },
        },
      }, ...contracts.slice(1)],
    },
    {
      ...fixture.snapshot,
      contracts: [{
        ...first,
        publicSchemas: {
          ...(first["publicSchemas"] as Record<string, unknown>),
          input: {
            ...((first["publicSchemas"] as Record<string, unknown>)["input"] as Record<string, unknown>),
            jsonSchema: { type: "null" },
          },
        },
      }, ...contracts.slice(1)],
    },
    {
      ...fixture.snapshot,
      contracts: [{
        ...first,
        classificationProvenance: {
          ...(first["classificationProvenance"] as Record<string, unknown>),
          reviewedSchemaDigest: `sha256:${"0".repeat(64)}`,
        },
      }, ...contracts.slice(1)],
    },
  ];
  const cases: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["signature", { ...fixture.pointer, signature: "A".repeat(86) + "==" }, fixture.snapshot],
    ["digest", { ...fixture.pointer, artifactSha256: "0".repeat(64) }, fixture.snapshot],
    ["artifact-digest", fixture.pointer, { ...fixture.snapshot, publishedAt: "2026-08-31T00:00:00.000Z" }],
    ["pointer-shape", { ...fixture.pointer, extra: true }, fixture.snapshot],
    ...malformedSnapshots.map((snapshot, index) => {
      const malformed = signedSnapshot(snapshot, fixture.pointer.catalogueVersion, fixture.signing);
      return [`snapshot-${index}`, malformed.pointer, malformed.snapshot] as const;
    }),
    (() => {
      const mismatched = signedSnapshot(fixture.snapshot, "2026-08-31.3", fixture.signing);
      return ["pointer-version", mismatched.pointer, mismatched.snapshot] as const;
    })(),
  ];
  for (const [label, pointer, artifact] of cases) {
    const result = await loaderFor(fixture, releaseFetch(pointer, artifact)).refresh();
    expect(result.source, label).toBe("bundled-fallback");
    expect(result.catalogue).toEqual(bundledComputerUseContractCatalogue);
  }
});

test("signed catalogue guidance cannot be changed without a matching artifact digest and signature", async () => {
  const fixture = signedFixture();
  const tampered = {
    ...fixture.snapshot,
    modelGuidance: "Unsigned replacement guidance",
  };

  const result = await loaderFor(
    fixture,
    releaseFetch(fixture.pointer, tampered),
  ).refresh();

  expect(result.source).toBe("bundled-fallback");
  expect(result.catalogue).toEqual(bundledComputerUseContractCatalogue);
});

test("single-flight cache serves stale LKG and rejects rollback or immutable-version conflict", async () => {
  const first = signedFixture();
  const lower = signedFixture("2026-09-03.1", "2026-09-03T00:00:00.000Z", undefined, first.signing);
  const conflict = signedFixture(
    first.pointer.catalogueVersion,
    first.snapshot["publishedAt"] as string,
    (snapshot) => {
      const contracts = snapshot["contracts"] as Array<Record<string, unknown>>;
      snapshot["contracts"] = contracts.map((entry, index) => index === 0
        ? {
          ...entry,
          projection: {
            ...(entry["projection"] as Record<string, unknown>),
            label: "Conflicting label",
          },
        }
        : entry);
    },
    first.signing,
  );
  const responses = [
    first.pointer,
    first.snapshot,
    lower.pointer,
    lower.snapshot,
    conflict.pointer,
    conflict.snapshot,
  ];
  let calls = 0;
  let now = 0;
  const loader = createRemoteComputerUseContractCatalogueLoader({
    pointerUrl: "https://catalogue.example.test/latest.json",
    trustedKeys: { test: first.publicKeyDer },
    now: () => now,
    ttlMs: 10,
    staleMs: 10,
    fetchImpl: (async () => json(responses[calls++])) as unknown as typeof fetch,
  });

  const [fresh, joined] = await Promise.all([loader.refresh(), loader.refresh()]);
  expect(fresh.source).toBe("remote-fresh");
  expect(joined).toEqual(fresh);
  expect(calls).toBe(2);

  now = 11;
  expect((await loader.get()).source).toBe("remote-stale");
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  expect(calls).toBe(4);
  expect((await loader.refresh()).source).toBe("remote-stale");
  expect(calls).toBe(6);
  now = -1;
  expect(await loader.get()).toMatchObject({
    source: "remote-stale",
    reason: "computer use contract catalogue clock rejected",
    catalogueVersion: first.pointer.catalogueVersion,
  });
});

test("catalogue upgrades must advance publication time from both the bundle and last-known-good release", async () => {
  const first = signedFixture();
  const sameBundleTime = signedFixture(
    laterCatalogueVersion(1),
    bundledComputerUseContractCatalogue.publishedAt,
    undefined,
    first.signing,
  );
  const sameCachedTime = signedFixture(
    laterCatalogueVersion(2),
    laterPublishedAt(1),
    undefined,
    first.signing,
  );
  const second = signedFixture(laterCatalogueVersion(3), laterPublishedAt(2), undefined, first.signing);
  const responses = [sameBundleTime, first, sameCachedTime, second]
    .flatMap((fixture) => [fixture.pointer, fixture.snapshot]);
  let calls = 0;
  const loader = loaderFor(first, (async () => json(responses[calls++])) as unknown as typeof fetch);

  expect(await loader.refresh()).toMatchObject({
    source: "bundled-fallback",
    catalogueVersion: bundledComputerUseContractCatalogue.catalogueVersion,
  });
  expect(await loader.refresh()).toMatchObject({
    source: "remote-fresh",
    catalogueVersion: first.pointer.catalogueVersion,
  });
  expect(await loader.refresh()).toMatchObject({
    source: "remote-stale",
    catalogueVersion: first.pointer.catalogueVersion,
  });
  expect(await loader.refresh()).toMatchObject({
    source: "remote-fresh",
    catalogueVersion: second.pointer.catalogueVersion,
  });
  expect(calls).toBe(8);
});

test("disabled loader is offline, runtime generations fence late refreshes, and public reasons are content-free", async () => {
  let disabledCalls = 0;
  const disabled = createRemoteComputerUseContractCatalogueLoader({
    fetchImpl: (async () => {
      disabledCalls += 1;
      throw new Error("must not fetch");
    }) as unknown as typeof fetch,
  });
  const disabledResult = await disabled.get();
  expect(disabledResult).toMatchObject({
    source: "bundled-fallback",
    catalogue: bundledComputerUseContractCatalogue,
  });
  expect(disabledResult.artifactSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(disabledCalls).toBe(0);

  const fixture = signedFixture();
  let resolvePointer: ((response: Response) => void) | undefined;
  configureRuntimeComputerUseContractCatalogue({
    pointerUrl: "https://catalogue.example.test/latest.json",
    trustedKeys: { test: fixture.publicKeyDer },
    fetchImpl: (async () => await new Promise<Response>((resolve) => {
      resolvePointer = resolve;
    })) as unknown as typeof fetch,
  });
  const old = refreshRuntimeComputerUseContractCatalogue();
  await Promise.resolve();
  expect(resolvePointer).toBeDefined();
  configureRuntimeComputerUseContractCatalogue({ pointerUrl: null });
  resolvePointer?.(json({ ...fixture.pointer, signature: "not-base64" }));
  await old;
  expect(getActiveComputerUseContractCatalogueResultSync().source).toBe("bundled-fallback");

  const failed = await createRemoteComputerUseContractCatalogueLoader({
    pointerUrl: "https://catalogue.example.test/latest.json",
    fetchImpl: (async () => { throw new Error("token=private-secret"); }) as unknown as typeof fetch,
  }).refresh();
  expect(failed.reason).toBe("computer use contract catalogue refresh failed");
  expect(failed.reason).not.toContain("secret");
  resetRuntimeComputerUseContractCatalogue();
});

test("an exact signed copy of the bundled catalogue proves the remote channel instead of masquerading as fallback", async () => {
  const keys = generateKeyPairSync("ed25519");
  const snapshot = JSON.parse(JSON.stringify(bundledComputerUseContractCatalogue)) as Record<string, unknown>;
  delete snapshot["provenance"];
  const artifactText = `${JSON.stringify(snapshot)}\n`;
  const artifactSha256 = createHash("sha256").update(artifactText).digest("hex");
  const pointer = {
    catalogueVersion: bundledComputerUseContractCatalogue.catalogueVersion,
    artifactSha256,
    signingKeyId: "test",
    signature: sign(
      null,
      Buffer.from(canonicalComputerUseContractCatalogueSigningPayloadV1(
        bundledComputerUseContractCatalogue.catalogueVersion,
        artifactSha256,
      )),
      keys.privateKey,
    ).toString("base64"),
  };
  let request = 0;
  const result = await createRemoteComputerUseContractCatalogueLoader({
    pointerUrl: "https://catalogue.example.test/latest.json",
    allowedHosts: ["catalogue.example.test"],
    trustedKeys: {
      test: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    },
    fetchImpl: (async () => request++ === 0
      ? json(pointer)
      : new Response(artifactText, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  }).refresh();
  expect(result).toMatchObject({
    source: "remote-fresh",
    stale: false,
    catalogueVersion: bundledComputerUseContractCatalogue.catalogueVersion,
  });
  expect(result.artifactSha256).toBe(bundledComputerUseContractCatalogueArtifactSha256);
});

test("the runtime refresh loop activates a newer signed catalogue and reports the contract change", async () => {
  const signing = generateKeyPairSync("ed25519");
  const firstVersion = laterCatalogueVersion(1);
  const secondVersion = laterCatalogueVersion(2);
  const first = signedFixture(firstVersion, laterPublishedAt(1), undefined, signing);
  const second = signedFixture(secondVersion, laterPublishedAt(2), undefined, signing);
  const responses = [first.pointer, first.snapshot, second.pointer, second.snapshot];
  let calls = 0;
  configureRuntimeComputerUseContractCatalogue({
    pointerUrl: "https://catalogue.example.test/latest.json",
    allowedHosts: ["catalogue.example.test"],
    trustedKeys: { test: first.publicKeyDer },
    fetchImpl: (async () => json(responses[calls++])) as unknown as typeof fetch,
  });
  try {
    expect((await refreshRuntimeComputerUseContractCatalogue()).catalogueVersion).toBe(firstVersion);
    const event = await new Promise<{ contractsChanged: boolean; catalogueVersion: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("refresh loop did not settle")), 1_000);
      startRuntimeComputerUseContractCatalogueRefreshLoop((refresh) => {
        clearTimeout(timeout);
        resolve({
          contractsChanged: refresh.contractsChanged,
          catalogueVersion: refresh.result.catalogueVersion,
        });
      }, 1);
    });
    expect(event).toEqual({ contractsChanged: true, catalogueVersion: secondVersion });
    expect(getActiveComputerUseContractCatalogueResultSync().catalogueVersion).toBe(secondVersion);
  } finally {
    stopRuntimeComputerUseContractCatalogueRefreshLoop();
    resetRuntimeComputerUseContractCatalogue();
  }
});

test("a failed live reconciliation leaves the signed catalogue unacknowledged and retries it", async () => {
  const signing = generateKeyPairSync("ed25519");
  const firstVersion = laterCatalogueVersion(1);
  const secondVersion = laterCatalogueVersion(2);
  const first = signedFixture(firstVersion, laterPublishedAt(1), undefined, signing);
  const second = signedFixture(secondVersion, laterPublishedAt(2), undefined, signing);
  const responses = [
    first.pointer,
    first.snapshot,
    second.pointer,
    second.snapshot,
    second.pointer,
    second.snapshot,
  ];
  let calls = 0;
  configureRuntimeComputerUseContractCatalogue({
    pointerUrl: "https://catalogue.example.test/latest.json",
    allowedHosts: ["catalogue.example.test"],
    trustedKeys: { test: first.publicKeyDer },
    fetchImpl: (async () => json(responses[calls++])) as unknown as typeof fetch,
  });
  try {
    expect((await refreshRuntimeComputerUseContractCatalogue()).catalogueVersion).toBe(firstVersion);
    let attempts = 0;
    const event = await new Promise<{ contractsChanged: boolean; catalogueVersion: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("failed catalogue reconciliation was not retried")), 1_000);
      startRuntimeComputerUseContractCatalogueRefreshLoop((refresh) => {
        attempts++;
        if (attempts === 1) throw new Error("simulated atomic swap rejection");
        clearTimeout(timeout);
        resolve({
          contractsChanged: refresh.contractsChanged,
          catalogueVersion: refresh.result.catalogueVersion,
        });
      }, 1);
    });
    expect(attempts).toBe(2);
    expect(event).toEqual({ contractsChanged: true, catalogueVersion: secondVersion });
  } finally {
    stopRuntimeComputerUseContractCatalogueRefreshLoop();
    resetRuntimeComputerUseContractCatalogue();
  }
});

test("catalogue versions and snapshot metadata are exact", () => {
  expect(compareComputerUseContractCatalogueVersionV1("2026-08-29.2", "2026-08-29.1")).toBe(1);
  expect(compareComputerUseContractCatalogueVersionV1("2026-08-29.1", "2026-08-29.2")).toBe(-1);
  expect(compareComputerUseContractCatalogueVersionV1("2026-08-29.1", "2026-08-29.1")).toBe(0);
  expect(() => compareComputerUseContractCatalogueVersionV1("2026-02-30.1", "2026-08-29.1"))
    .toThrow("version rejected");
  const snapshot = JSON.parse(JSON.stringify(bundledComputerUseContractCatalogue)) as Record<string, unknown>;
  delete snapshot["provenance"];
  expect(computerUseContractCatalogueSnapshotV1Schema.safeParse(snapshot).success).toBe(true);
  expect(computerUseContractCatalogueSnapshotV1Schema.safeParse({
    ...snapshot,
    provenance: "remote",
  }).success).toBe(false);
});
