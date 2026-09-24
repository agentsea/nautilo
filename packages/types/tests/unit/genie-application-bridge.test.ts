import { expect, test } from "bun:test";

import {
  GENIE_HANDOFF_MAX_CONTEXT_ENTRIES_V1,
  GUIDE_USER_MAX_DISCOVERY_RESULTS_V1,
  UI_ACTION_EVENT_TTL_MS,
  UI_TARGET_DEFINITIONS_V1,
  UI_TARGET_IDS_V1,
  BUNDLED_APPLICATION_CATALOGUE_V1,
  CLIENT_ACTION_BINDING_ADMISSIONS_PER_MINUTE,
  CLIENT_ACTION_BINDING_TTL_MS,
  CLIENT_ACTION_MAX_LIVE_BINDINGS_PER_SOCKET,
  applicationCatalogueV1Schema,
  applicationCatalogueReleasePointerV1Schema,
  canonicalApplicationCatalogueSigningPayloadV1,
  clientSessionEventV1Schema,
  compareApplicationCatalogueVersionV1,
  immutableApplicationCatalogueFilenameV1,
  initiatingClientSurfaceV1Schema,
  genieHandoffV1Schema,
  genieRecoveryV1Schema,
  genieRecoveryResultV1Schema,
  guideUserArgsV1Schema,
  guideUserResultV1Schema,
  parseUiActionEventV1,
  parseClientSessionEventV1,
  parseInitiatingClientSurfaceV1,
  UI_ACTION_MAX_RETAINED_IDS_PER_SOCKET,
  parseGenieHandoffV1,
  uiActionEventV1Schema,
  uiTargetChannelAdapterV1Schema,
  uiTargetDefinitionV1Schema,
  uiPresentationSchema,
} from "../../src/genie-application-bridge";

const actionNow = Date.UTC(2026, 7, 11, 12, 0, 0);
const actionExpiry = new Date(actionNow + UI_ACTION_EVENT_TTL_MS).toISOString();

test("the v1 registry is finite, semantic, and covers every target exactly once", () => {
  expect(UI_TARGET_DEFINITIONS_V1).toHaveLength(55);
  expect(UI_TARGET_DEFINITIONS_V1.map((definition) => definition.target).sort()).toEqual([...UI_TARGET_IDS_V1].sort());
  expect(new Set(UI_TARGET_DEFINITIONS_V1.map((definition) => definition.target)).size).toBe(UI_TARGET_IDS_V1.length);
  for (const definition of UI_TARGET_DEFINITIONS_V1) {
    expect(uiTargetDefinitionV1Schema.safeParse(definition).success).toBe(true);
    expect(definition.label).not.toMatch(/[\\/#<>`]/);
    expect(definition.menuPath.join(" ")).not.toMatch(/[\\/#<>`]/);
    expect(definition.discoveryTerms.join(" ")).not.toMatch(/[\\/#<>`]/);
  }
});

test("the bundled catalogue envelope is closed, bounded, and exact", () => {
  expect(applicationCatalogueV1Schema.safeParse(BUNDLED_APPLICATION_CATALOGUE_V1).success).toBe(true);
  for (const executableField of [
    "route", "href", "hash", "selector", "focusAnchorId", "component",
    "nativeHandler", "capability", "availability", "mutation", "action", "handler",
  ]) {
    expect(applicationCatalogueV1Schema.safeParse({
      ...BUNDLED_APPLICATION_CATALOGUE_V1,
      [executableField]: "forbidden",
    }).success).toBe(false);
    expect(applicationCatalogueV1Schema.safeParse({
      ...BUNDLED_APPLICATION_CATALOGUE_V1,
      targets: [{ ...BUNDLED_APPLICATION_CATALOGUE_V1.targets[0], [executableField]: "forbidden" }, ...BUNDLED_APPLICATION_CATALOGUE_V1.targets.slice(1)],
    }).success).toBe(false);
  }
  expect(applicationCatalogueV1Schema.safeParse({ ...BUNDLED_APPLICATION_CATALOGUE_V1, targets: [...BUNDLED_APPLICATION_CATALOGUE_V1.targets, BUNDLED_APPLICATION_CATALOGUE_V1.targets[0]] }).success).toBe(false);
  expect(applicationCatalogueV1Schema.safeParse({ ...BUNDLED_APPLICATION_CATALOGUE_V1, targets: BUNDLED_APPLICATION_CATALOGUE_V1.targets.slice(1) }).success).toBe(false);
  expect(applicationCatalogueV1Schema.safeParse({ ...BUNDLED_APPLICATION_CATALOGUE_V1, targets: [...BUNDLED_APPLICATION_CATALOGUE_V1.targets.slice(1), { ...BUNDLED_APPLICATION_CATALOGUE_V1.targets[0], target: "unknown.target" }] }).success).toBe(false);
});

test("application catalogue pointer has a closed signing domain and immutable filename", () => {
  const pointer = { catalogueVersion: "2026-08-12.1", artifactSha256: "a".repeat(64), signature: "A".repeat(86) + "==", signingKeyId: "catalog-2026-07-17" };
  expect(applicationCatalogueReleasePointerV1Schema.safeParse(pointer).success).toBe(true);
  expect(applicationCatalogueReleasePointerV1Schema.safeParse({ ...pointer, signature: "short" }).success).toBe(false);
  expect(canonicalApplicationCatalogueSigningPayloadV1(pointer.catalogueVersion, pointer.artifactSha256)).toBe(`nautilo-application-catalogue-v1\ncatalogueVersion=${pointer.catalogueVersion}\nartifactSha256=${pointer.artifactSha256}\n`);
  expect(immutableApplicationCatalogueFilenameV1(pointer.catalogueVersion)).toBe("application-catalogue-2026-08-12.1.json");
  expect(applicationCatalogueReleasePointerV1Schema.safeParse({ ...pointer, catalogueVersion: "1" }).success).toBe(false);
  expect(applicationCatalogueReleasePointerV1Schema.safeParse({ ...pointer, catalogueVersion: "2026-02-30.1" }).success).toBe(false);
  expect(compareApplicationCatalogueVersionV1("2026-08-12.2", "2026-08-12.1")).toBeGreaterThan(0);
  expect(compareApplicationCatalogueVersionV1("2026-08-13.1", "2026-08-12.999999")).toBeGreaterThan(0);
  expect(() => compareApplicationCatalogueVersionV1("invalid", pointer.catalogueVersion)).toThrow();
});

test("client-session control and exact-client bounds are closed and derived", () => {
  const event = {
    type: "client.session.v1",
    clientActionSessionId: "A1b2C3d4E5f6G7h8I9j0K_",
  } as const;
  expect(clientSessionEventV1Schema.safeParse(event).success).toBe(true);
  expect(parseClientSessionEventV1(event)).toEqual(event);
  expect(clientSessionEventV1Schema.safeParse({ ...event, roomId: "room-a" }).success).toBe(false);
  expect(clientSessionEventV1Schema.safeParse({ ...event, clientActionSessionId: "short" }).success).toBe(false);
  expect(clientSessionEventV1Schema.safeParse({
    ...event,
    clientActionSessionId: "-1b2C3d4E5f6G7h8I9j0K_",
  }).success).toBe(false);
  expect(CLIENT_ACTION_BINDING_ADMISSIONS_PER_MINUTE).toBe(60);
  expect(CLIENT_ACTION_BINDING_TTL_MS).toBe(15 * 60 * 1_000);
  expect(CLIENT_ACTION_MAX_LIVE_BINDINGS_PER_SOCKET).toBe(900);
  expect(UI_ACTION_EVENT_TTL_MS).toBe(30_000);
  expect(UI_ACTION_MAX_RETAINED_IDS_PER_SOCKET).toBe(60);
});

test("initiating surface declarations are closed and old clients fail to unknown", () => {
  expect(initiatingClientSurfaceV1Schema.options).toEqual([
    "workbench.browser", "workbench.desktop", "mobile.native", "mobile.web", "unknown",
  ]);
  expect(parseInitiatingClientSurfaceV1("mobile.web")).toBe("mobile.web");
  expect(parseInitiatingClientSurfaceV1(undefined)).toBe("unknown");
  expect(parseInitiatingClientSurfaceV1("forged.surface")).toBe("unknown");
});

test("channel adapter dispositions are exhaustive, closed, and route-free", () => {
  const allSupported = {
    dispositions: Object.fromEntries(UI_TARGET_IDS_V1.map((target) => [target, { status: "supported" }])),
  };
  expect(uiTargetChannelAdapterV1Schema.safeParse(allSupported).success).toBe(true);

  const mixed = {
    dispositions: {
      ...allSupported.dispositions,
      "connections.local_mcp": { status: "unsupported", fallbackText: "This Channel does not support Local MCP guidance." },
    },
  };
  expect(uiTargetChannelAdapterV1Schema.safeParse(mixed).success).toBe(true);
  for (const missingTarget of UI_TARGET_IDS_V1) {
    const missing = Object.fromEntries(
      Object.entries(allSupported.dispositions).filter(([target]) => target !== missingTarget),
    );
    expect(uiTargetChannelAdapterV1Schema.safeParse({ dispositions: missing }).success).toBe(false);
  }
  expect(uiTargetChannelAdapterV1Schema.safeParse({
    dispositions: { ...allSupported.dispositions, "connections.future": { status: "supported" } },
  }).success).toBe(false);
  expect(uiTargetChannelAdapterV1Schema.safeParse({
    dispositions: { ...allSupported.dispositions, "connections.ssh": { status: "supported", href: "/connections#ssh" } },
  }).success).toBe(false);
  expect(uiTargetChannelAdapterV1Schema.safeParse({
    dispositions: { ...allSupported.dispositions, "connections.ssh": { status: "unsupported" } },
  }).success).toBe(false);
  expect(uiTargetChannelAdapterV1Schema.safeParse({
    dispositions: { ...allSupported.dispositions, "connections.ssh": { status: "unsupported", fallbackText: "Use /connections#ssh instead." } },
  }).success).toBe(false);
  expect(uiTargetChannelAdapterV1Schema.safeParse({
    dispositions: { ...allSupported.dispositions, "connections.ssh": { status: "unsupported", fallbackText: "x".repeat(513) } },
  }).success).toBe(false);
});

test("guide_user accepts only bounded discovery or one approved semantic presentation", () => {
  expect(guideUserArgsV1Schema.safeParse({ version: 1, query: "SSH setup" }).success).toBe(true);
  expect(guideUserArgsV1Schema.safeParse({ version: 1, query: "e\u0301" }).success).toBe(false);
  expect(guideUserArgsV1Schema.safeParse({ version: 1, query: "x".repeat(161) }).success).toBe(false);
  expect(guideUserArgsV1Schema.safeParse({ version: 1, query: "🙂".repeat(41) }).success).toBe(false);
  expect(guideUserArgsV1Schema.safeParse({ version: 1, query: "/connections#ssh" }).success).toBe(false);
  expect(guideUserArgsV1Schema.safeParse({ version: 1, query: "#ssh-control" }).success).toBe(false);
  expect(guideUserArgsV1Schema.safeParse({ version: 1, query: "button[data-testid=ssh]" }).success).toBe(false);
  expect(guideUserArgsV1Schema.safeParse({ version: 1, query: "document.querySelector(SSH)" }).success).toBe(false);
  expect(guideUserArgsV1Schema.safeParse({ version: 1, query: "javascript:alert(1)" }).success).toBe(false);
  expect(guideUserArgsV1Schema.safeParse({ version: 2, query: "SSH" }).success).toBe(false);
  expect(guideUserArgsV1Schema.safeParse({ version: 1, query: "SSH", target: "connections.ssh" }).success).toBe(false);

  for (const target of UI_TARGET_IDS_V1) {
    for (const presentation of uiPresentationSchema.options) {
      for (const confirmed of [false, true]) {
      expect(guideUserArgsV1Schema.safeParse({
          version: 1, target, presentation, confirmed,
      }).success).toBe(true);
      }
    }
  }
  for (const presentation of uiPresentationSchema.options) {
    expect(guideUserArgsV1Schema.safeParse({
      version: 1, target: "connections.ssh", presentation, confirmed: presentation !== "link",
      route: "/connections#ssh",
    }).success).toBe(false);
  }
  expect(guideUserArgsV1Schema.safeParse({
    version: 1, target: "/connections#ssh", presentation: "link", confirmed: false,
  }).success).toBe(false);
});

test("guide_user results are bounded, unique, durable, and never claim automatic opening", () => {
  const discovery = {
    version: 1,
    kind: "discovery",
    targets: UI_TARGET_DEFINITIONS_V1.slice(0, GUIDE_USER_MAX_DISCOVERY_RESULTS_V1).map(({ discoveryTerms, ...target }) => target),
  } as const;
  expect(guideUserResultV1Schema.safeParse(discovery).success).toBe(true);
  expect(guideUserResultV1Schema.safeParse({ ...discovery, targets: [...discovery.targets, discovery.targets[0]] }).success).toBe(false);
  expect(guideUserResultV1Schema.safeParse({ ...discovery, selector: "#ssh-control" }).success).toBe(false);
  expect(guideUserResultV1Schema.safeParse({
    ...discovery,
    targets: [{ ...discovery.targets[0], description: "SshConnectionSection" }],
  }).success).toBe(false);
  expect(guideUserResultV1Schema.safeParse({
    version: 1,
    kind: "guidance",
    actionId: "guide-1",
    target: "connections.ssh",
    presentation: "link",
    fallbackText: "Use the SSH action to continue.",
  }).success).toBe(true);
  expect(guideUserResultV1Schema.safeParse({
    version: 1,
    kind: "guidance",
    actionId: "guide-1",
    target: "connections.ssh",
    presentation: "link",
    fallbackText: "Opened SSH for you.",
  }).success).toBe(false);
  expect(guideUserResultV1Schema.safeParse({
    version: 1,
    kind: "guidance",
    actionId: "guide-1",
    target: "connections.ssh",
    presentation: "link",
    fallbackText: "Use /connections#ssh to continue.",
  }).success).toBe(false);
});

test("the exact-client event permits exactly one finite, future, TTL-bounded automatic presentation", () => {
  for (const target of UI_TARGET_IDS_V1) {
    for (const presentation of ["reveal", "spotlight"] as const) {
      expect(() => parseUiActionEventV1({
        type: "ui.action.v1", actionId: "action-1", target, presentation, expiresAt: actionExpiry,
      }, actionNow)).not.toThrow();
    }
  }
  expect(() => parseUiActionEventV1({
    type: "ui.action.v1", actionId: "action-1", target: "connections.ssh", presentation: "link", expiresAt: actionExpiry,
  }, actionNow)).toThrow();
  expect(() => parseUiActionEventV1({
    type: "ui.action.v1", actionId: "action-1", target: "connections.ssh", presentation: "reveal", expiresAt: "not-a-date",
  }, actionNow)).toThrow();
  expect(() => parseUiActionEventV1({
    type: "ui.action.v1", actionId: "action-1", target: "connections.ssh", presentation: "reveal", expiresAt: new Date(actionNow).toISOString(),
  }, actionNow)).toThrow();
  expect(() => parseUiActionEventV1({
    type: "ui.action.v1", actionId: "action-1", target: "connections.ssh", presentation: "reveal", expiresAt: new Date(actionNow - 1).toISOString(),
  }, actionNow)).toThrow();
  expect(() => parseUiActionEventV1({
    type: "ui.action.v1", actionId: "action-1", target: "connections.ssh", presentation: "reveal", expiresAt: new Date(actionNow + UI_ACTION_EVENT_TTL_MS + 1).toISOString(),
  }, actionNow)).toThrow();
  expect(() => parseUiActionEventV1({
    type: "ui.action.v1", actionId: "action-1", target: "connections.ssh", presentation: "reveal", expiresAt: actionExpiry, actions: [],
  }, actionNow)).toThrow();
  expect(uiActionEventV1Schema.safeParse({
    type: "ui.action.v1", actionId: "action-1", target: "connections.ssh", presentation: "reveal", expiresAt: new Date(Date.now() + UI_ACTION_EVENT_TTL_MS - 1_000).toISOString(),
  }).success).toBe(true);
});

test("recovery metadata is closed and semantic", () => {
  for (const requirement of ["human_enablement", "pin", "login", "desktop"] as const) {
    expect(genieRecoveryV1Schema.safeParse({ target: "connections.ssh", requirement, domainTool: "enable_ssh" }).success).toBe(true);
  }
  expect(genieRecoveryV1Schema.safeParse({
    target: "connections.ssh", requirement: "pin", route: "/connections#ssh",
  }).success).toBe(false);
  expect(genieRecoveryV1Schema.safeParse({
    target: "connections.ssh", requirement: "selector",
  }).success).toBe(false);
  expect(genieRecoveryResultV1Schema.safeParse({
    version: 1,
    text: "Open Connections then SSH to continue.",
    recovery: { target: "connections.ssh", requirement: "pin" },
  }).success).toBe(true);
  expect(genieRecoveryResultV1Schema.safeParse({
    version: 1,
    text: "Open /connections#ssh to continue.",
    recovery: { target: "connections.ssh", requirement: "pin" },
  }).success).toBe(false);
  expect(genieRecoveryResultV1Schema.safeParse({
    version: 1,
    text: "Open SSH to continue.",
    recovery: { target: "connections.ssh", requirement: "pin" },
    route: "/connections#ssh",
  }).success).toBe(false);
});

test("handoffs are flat, bounded, source-aware, and reject secrets without echoing them", () => {
  const browserHandoff = {
    version: 1,
    source: "browser.page",
    intent: "Help me understand this page.",
    context: { url: "https://example.test/article", selection: "A selected paragraph." },
    delivery: "draft-current-room",
  } as const;
  expect(genieHandoffV1Schema.safeParse(browserHandoff).success).toBe(true);
  expect(genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: { url: "https://example.test/article#details" },
  }).success).toBe(true);

  expect(genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: { url: "https://user:test@example.test/article" },
  }).success).toBe(false);
  expect(genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: { url: "https://example.test/article?access_token=not-for-chat" },
  }).success).toBe(false);
  expect(genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: { url: "https://example.test/article#access_token=not-for-chat" },
  }).success).toBe(false);
  expect(genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: { url: "https://example.test/article#code=not-for-chat" },
  }).success).toBe(false);
  expect(genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: { url: "https://example.test/article#OAuth%5FCode=not-for-chat" },
  }).success).toBe(false);
  expect(genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: { url: "https://example.test/article#%EF%BD%83%EF%BD%8F%EF%BD%84%EF%BD%85=not-for-chat" },
  }).success).toBe(false);
  expect(genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: { url: "https://example.test/article#callback?ACCESS-TOKEN=not-for-chat" },
  }).success).toBe(false);
  expect(genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: { url: "https://example.test/article#code%3Dnot-for-chat" },
  }).success).toBe(false);
  expect(genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: { url: "https://example.test/article#callback%3Fcode%3Dnot-for-chat" },
  }).success).toBe(false);
  expect(genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: { url: "https://example.test/article#oauth2_code=not-for-chat" },
  }).success).toBe(false);
  expect(genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: { url: "https://example.test/article#x_access_token=not-for-chat" },
  }).success).toBe(false);
  expect(genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: { url: "https://example.test/article?X-Amz-Signature=deadbeefcafebabe" },
  }).success).toBe(false);
  expect(genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: { url: "https://example.test/article#postcode=28080" },
  }).success).toBe(true);
  const fragmentSecret = "sk-this-fragment-value-must-not-appear-in-errors";
  const secretFragment = genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: { url: `https://example.test/article#code=${fragmentSecret}` },
  });
  expect(secretFragment.success).toBe(false);
  if (!secretFragment.success) expect(JSON.stringify(secretFragment.error)).not.toContain(fragmentSecret);
  expect(genieHandoffV1Schema.safeParse({
    version: 1,
    source: "connections.local_mcp",
    intent: "Set up this local MCP.",
    context: { clientSecret: "never-log-this-value" },
    delivery: "send-new-room",
  }).success).toBe(false);
  expect(genieHandoffV1Schema.safeParse({
    version: 1,
    source: "connections.local_mcp",
    intent: "Set up this local MCP.",
    context: { config: "Authorization: Bearer never-log-this-value" },
    delivery: "send-new-room",
  }).success).toBe(false);
  expect(genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: { url: "https://example.test", nested: { not: "flat" } },
  }).success).toBe(false);
  expect(genieHandoffV1Schema.safeParse({
    ...browserHandoff,
    context: Object.fromEntries(Array.from({ length: GENIE_HANDOFF_MAX_CONTEXT_ENTRIES_V1 + 1 }, (_, index) => [`field${index}`, "value"])),
  }).success).toBe(false);

  const secret = "sk-this-value-must-not-appear-in-errors";
  const parsed = genieHandoffV1Schema.safeParse({
    version: 1,
    source: "connections.local_mcp",
    intent: "Set up this local MCP.",
    context: { config: secret },
    delivery: "send-new-room",
  });
  expect(parsed.success).toBe(false);
  if (!parsed.success) expect(JSON.stringify(parsed.error)).not.toContain(secret);
  const unsafeKey = "sk-this-value-must-not-appear-in-errors";
  const unsafeSchemaResult = genieHandoffV1Schema.safeParse({
    version: 1,
    source: "connections.local_mcp",
    intent: "Set up this local MCP.",
    context: { [unsafeKey]: "safe-placeholder" },
    delivery: "send-new-room",
  });
  expect(unsafeSchemaResult.success).toBe(false);
  if (!unsafeSchemaResult.success) {
    expect(String(unsafeSchemaResult.error)).not.toContain(unsafeKey);
    expect(JSON.stringify(unsafeSchemaResult.error)).not.toContain(unsafeKey);
  }
  let unsafeKeyError: unknown;
  try {
    parseGenieHandoffV1({
      version: 1,
      source: "connections.local_mcp",
      intent: "Set up this local MCP.",
      context: { [unsafeKey]: "safe-placeholder" },
      delivery: "send-new-room",
    });
  } catch (error) {
    unsafeKeyError = error;
  }
  expect(unsafeKeyError).toBeDefined();
  expect(String(unsafeKeyError)).not.toContain(unsafeKey);
  expect(JSON.stringify(unsafeKeyError)).not.toContain(unsafeKey);
});
