/**
 * D345 Phase 1 — config-backed tool runtime path persistence.
 *
 * Pure schema/helpers for `tool-runtimes.json` (or equivalent). Tests the
 * defensive gate between stored JSON and relay binary resolution without
 * booting Electron or touching the filesystem.
 *
 * Production module: `apps/desktop/electron/tool-runtime-config.ts`
 */

import { describe, expect, test } from "bun:test";
import {
  TOOL_RUNTIME_CONFIG_VERSION,
  clearToolRuntimePath,
  emptyToolRuntimeConfig,
  parseToolRuntimeConfig,
  upsertToolRuntimePath,
  type ToolRuntimeConfig,
  type ToolRuntimeToolName,
} from "../../electron/tool-runtime-config";

const KNOWN_TOOLS: ToolRuntimeToolName[] = ["agent-browser", "gog"];

describe("TOOL_RUNTIME_CONFIG_VERSION", () => {
  test("schema version is locked at 1", () => {
    expect(TOOL_RUNTIME_CONFIG_VERSION).toBe(1);
  });
});

describe("emptyToolRuntimeConfig", () => {
  test("returns version 1 with no tool entries", () => {
    expect(emptyToolRuntimeConfig()).toEqual({
      version: 1,
      tools: {},
    });
  });
});

describe("parseToolRuntimeConfig — valid shapes", () => {
  test("normalizes a full config with both known tools", () => {
    expect(
      parseToolRuntimeConfig({
        version: 1,
        tools: {
          "agent-browser": {
            configuredPath: "/opt/homebrew/bin/agent-browser",
            source: "auto-detected",
            lastKnownVersion: "0.4.0",
            lastHealth: "healthy",
            lastCheckedAt: "2026-06-25T12:00:00.000Z",
          },
          gog: {
            configuredPath: "/opt/homebrew/bin/gog",
            source: "manual",
            lastKnownVersion: "0.9.1",
            lastHealth: "auth-missing",
            lastCheckedAt: "2026-06-25T11:30:00.000Z",
          },
          "unknown-tool": {
            configuredPath: "/tmp/ignored",
            source: "manual",
          },
        },
      }),
    ).toEqual({
      version: 1,
      tools: {
        "agent-browser": {
          configuredPath: "/opt/homebrew/bin/agent-browser",
          source: "auto-detected",
          lastKnownVersion: "0.4.0",
          lastHealth: "healthy",
          lastCheckedAt: "2026-06-25T12:00:00.000Z",
        },
        gog: {
          configuredPath: "/opt/homebrew/bin/gog",
          source: "manual",
          lastKnownVersion: "0.9.1",
          lastHealth: "auth-missing",
          lastCheckedAt: "2026-06-25T11:30:00.000Z",
        },
      },
    });
  });

  test("accepts empty tools object", () => {
    expect(parseToolRuntimeConfig({ version: 1, tools: {} })).toEqual({
      version: 1,
      tools: {},
    });
  });

  test("accepts a single known tool entry", () => {
    expect(
      parseToolRuntimeConfig({
        version: 1,
        tools: {
          gog: {
            configuredPath: "/usr/local/bin/gog",
            source: "bundled",
          },
        },
      }),
    ).toEqual({
      version: 1,
      tools: {
        gog: {
          configuredPath: "/usr/local/bin/gog",
          source: "bundled",
        },
      },
    });
  });

  test("drops invalid optional fields but keeps a valid entry", () => {
    expect(
      parseToolRuntimeConfig({
        version: 1,
        tools: {
          "agent-browser": {
            configuredPath: "/opt/homebrew/bin/agent-browser",
            source: "auto-detected",
            lastKnownVersion: 42,
            lastHealth: null,
            lastCheckedAt: ["not", "a", "string"],
          },
        },
      }),
    ).toEqual({
      version: 1,
      tools: {
        "agent-browser": {
          configuredPath: "/opt/homebrew/bin/agent-browser",
          source: "auto-detected",
        },
      },
    });
  });

  test("ignores extra fields on tool entries", () => {
    expect(
      parseToolRuntimeConfig({
        version: 1,
        tools: {
          gog: {
            configuredPath: "/opt/homebrew/bin/gog",
            source: "manual",
            hobby: "gardening",
          },
        },
      }),
    ).toEqual({
      version: 1,
      tools: {
        gog: {
          configuredPath: "/opt/homebrew/bin/gog",
          source: "manual",
        },
      },
    });
  });
});

describe("parseToolRuntimeConfig — rejections", () => {
  test("null / undefined / primitive", () => {
    expect(parseToolRuntimeConfig(null)).toBeNull();
    expect(parseToolRuntimeConfig(undefined)).toBeNull();
    expect(parseToolRuntimeConfig("string")).toBeNull();
    expect(parseToolRuntimeConfig(42)).toBeNull();
  });

  test("invalid top-level version returns null", () => {
    expect(parseToolRuntimeConfig({ version: 0, tools: {} })).toBeNull();
    expect(parseToolRuntimeConfig({ version: 2, tools: {} })).toBeNull();
    expect(parseToolRuntimeConfig({ version: "1", tools: {} })).toBeNull();
    expect(parseToolRuntimeConfig({ tools: {} })).toBeNull();
  });

  test("missing or malformed tools object returns null", () => {
    expect(parseToolRuntimeConfig({ version: 1 })).toBeNull();
    expect(parseToolRuntimeConfig({ version: 1, tools: null })).toBeNull();
    expect(parseToolRuntimeConfig({ version: 1, tools: "nope" })).toBeNull();
    expect(parseToolRuntimeConfig({ version: 1, tools: [] })).toBeNull();
  });
});

describe("parseToolRuntimeConfig — partial recovery", () => {
  test("unknown tool keys are ignored", () => {
    expect(
      parseToolRuntimeConfig({
        version: 1,
        tools: {
          curl: {
            configuredPath: "/usr/bin/curl",
            source: "manual",
          },
          "agent-browser": {
            configuredPath: "/opt/homebrew/bin/agent-browser",
            source: "auto-detected",
          },
        },
      }),
    ).toEqual({
      version: 1,
      tools: {
        "agent-browser": {
          configuredPath: "/opt/homebrew/bin/agent-browser",
          source: "auto-detected",
        },
      },
    });
  });

  test("invalid known tool entries are omitted without failing the parse", () => {
    expect(
      parseToolRuntimeConfig({
        version: 1,
        tools: {
          "agent-browser": {
            configuredPath: "",
            source: "manual",
          },
          gog: {
            configuredPath: "/opt/homebrew/bin/gog",
            source: "auto-detected",
          },
        },
      }),
    ).toEqual({
      version: 1,
      tools: {
        gog: {
          configuredPath: "/opt/homebrew/bin/gog",
          source: "auto-detected",
        },
      },
    });
  });

  test("omits entries missing required configuredPath or source", () => {
    expect(
      parseToolRuntimeConfig({
        version: 1,
        tools: {
          "agent-browser": {
            source: "manual",
          },
          gog: {
            configuredPath: "/opt/homebrew/bin/gog",
          },
        },
      }),
    ).toEqual({
      version: 1,
      tools: {},
    });
  });

  test("non-object tool entries are skipped", () => {
    expect(
      parseToolRuntimeConfig({
        version: 1,
        tools: {
          "agent-browser": "/opt/homebrew/bin/agent-browser",
          gog: {
            configuredPath: "/opt/homebrew/bin/gog",
            source: "manual",
          },
        },
      }),
    ).toEqual({
      version: 1,
      tools: {
        gog: {
          configuredPath: "/opt/homebrew/bin/gog",
          source: "manual",
        },
      },
    });
  });
});

describe("known tool names", () => {
  test("only agent-browser and gog are accepted tool keys", () => {
    for (const tool of KNOWN_TOOLS) {
      const parsed = parseToolRuntimeConfig({
        version: 1,
        tools: {
          [tool]: {
            configuredPath: `/opt/homebrew/bin/${tool}`,
            source: "manual",
          },
        },
      });
      expect(parsed?.tools[tool]).toEqual({
        configuredPath: `/opt/homebrew/bin/${tool}`,
        source: "manual",
      });
    }
  });
});

describe("upsertToolRuntimePath", () => {
  test("adds a configured path for a known tool", () => {
    const base = emptyToolRuntimeConfig();
    const next = upsertToolRuntimePath(
      base,
      "agent-browser",
      "/opt/homebrew/bin/agent-browser",
      "auto-detected",
    );
    expect(next).toEqual({
      version: 1,
      tools: {
        "agent-browser": {
          configuredPath: "/opt/homebrew/bin/agent-browser",
          source: "auto-detected",
        },
      },
    });
  });

  test("updates an existing tool without dropping the sibling entry", () => {
    const base: ToolRuntimeConfig = {
      version: 1,
      tools: {
        "agent-browser": {
          configuredPath: "/usr/local/bin/agent-browser",
          source: "manual",
          lastKnownVersion: "0.3.0",
        },
        gog: {
          configuredPath: "/opt/homebrew/bin/gog",
          source: "auto-detected",
        },
      },
    };

    const next = upsertToolRuntimePath(
      base,
      "agent-browser",
      "/opt/homebrew/bin/agent-browser",
      "auto-detected",
    );

    expect(next).toEqual({
      version: 1,
      tools: {
        "agent-browser": {
          configuredPath: "/opt/homebrew/bin/agent-browser",
          source: "auto-detected",
        },
        gog: {
          configuredPath: "/opt/homebrew/bin/gog",
          source: "auto-detected",
        },
      },
    });
  });

  test("does not mutate the input config", () => {
    const base = emptyToolRuntimeConfig();
    const snapshot = structuredClone(base);
    upsertToolRuntimePath(base, "gog", "/opt/homebrew/bin/gog", "manual");
    expect(base).toEqual(snapshot);
  });
});

describe("clearToolRuntimePath", () => {
  test("removes a configured tool entry", () => {
    const base: ToolRuntimeConfig = {
      version: 1,
      tools: {
        "agent-browser": {
          configuredPath: "/opt/homebrew/bin/agent-browser",
          source: "auto-detected",
        },
        gog: {
          configuredPath: "/opt/homebrew/bin/gog",
          source: "manual",
        },
      },
    };

    expect(clearToolRuntimePath(base, "gog")).toEqual({
      version: 1,
      tools: {
        "agent-browser": {
          configuredPath: "/opt/homebrew/bin/agent-browser",
          source: "auto-detected",
        },
      },
    });
  });

  test("is a no-op when the tool is not configured", () => {
    const base = emptyToolRuntimeConfig();
    expect(clearToolRuntimePath(base, "agent-browser")).toEqual(base);
  });

  test("does not mutate the input config", () => {
    const base: ToolRuntimeConfig = {
      version: 1,
      tools: {
        gog: {
          configuredPath: "/opt/homebrew/bin/gog",
          source: "manual",
        },
      },
    };
    const snapshot = structuredClone(base);
    clearToolRuntimePath(base, "gog");
    expect(base).toEqual(snapshot);
  });
});

describe("round-trip helpers", () => {
  test("upsert then clear returns to empty tools", () => {
    let config = emptyToolRuntimeConfig();
    config = upsertToolRuntimePath(
      config,
      "agent-browser",
      "/opt/homebrew/bin/agent-browser",
      "auto-detected",
    );
    config = upsertToolRuntimePath(
      config,
      "gog",
      "/opt/homebrew/bin/gog",
      "auto-detected",
    );
    config = clearToolRuntimePath(config, "agent-browser");
    config = clearToolRuntimePath(config, "gog");
    expect(config).toEqual(emptyToolRuntimeConfig());
  });

  test("parse accepts JSON produced by upsert helpers", () => {
    const raw = upsertToolRuntimePath(
      upsertToolRuntimePath(
        emptyToolRuntimeConfig(),
        "agent-browser",
        "/opt/homebrew/bin/agent-browser",
        "auto-detected",
      ),
      "gog",
      "/opt/homebrew/bin/gog",
      "manual",
    );

    expect(parseToolRuntimeConfig(raw)).toEqual(raw);
  });
});
