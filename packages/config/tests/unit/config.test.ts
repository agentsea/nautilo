import { describe, expect, test } from "bun:test";
import {
  fromRuntimeConfig,
  invalidateRuntimeConfigCache,
  normalizeUserConfig,
  resolveServerPosture,
  setConfigOverrides,
} from "../../src/config";

function minimalUserConfig(tools?: unknown) {
  return {
    models: { embedding: {} },
    history: {},
    memory: {},
    research: {},
    session: {},
    home: {},
    storage: {},
    soul: {},
    voice: {},
    logging: {},
    ...(tools === undefined ? {} : { tools }),
  };
}

describe("config", () => {
  test("returns defaults when no overrides or env", () => {
    const config = fromRuntimeConfig();
    expect(config.nautilo_model).toBe("");
    expect(config.nautilo_embedding_model).toBe("");
    expect(config.nautilo_embedding_dims).toBe(1536);
    expect(config.nautilo_session_search_model).toBe("");
    expect(config.nautilo_conductor_model).toBe("");
    expect(config.nautilo_web_search_model).toBe("");
    expect(config.nautilo_flush_model).toBe("");
    expect(config.nautilo_reviewer_model).toBe("");
    expect(config.nautilo_browser_decision_model).toBe("");
    expect(config.nautilo_browser_decision_intervention_limit).toBe(2);
    expect(config.nautilo_token_budget_fraction).toBe(0.6);
    expect(config.nautilo_memory_brief_char_limit).toBe(8000);
    expect(config.nautilo_memory_search_limit).toBe(10);
    expect(config.nautilo_session_search_limit).toBe(5);
    expect(config.nautilo_memory_dedup_similarity_threshold).toBe(0.9);
    expect(config.nautilo_search_provider).toBe("auto");
    expect(config.nautilo_search_max_results).toBe(5);
    expect(config.nautilo_search_depth).toBe("basic");
    expect(config.nautilo_search_read_page_count).toBe(2);
    expect(config.nautilo_search_exclude_domains).toEqual([
      "reddit.com",
      "facebook.com",
      "quora.com",
      "pinterest.com",
      "tiktok.com",
    ]);
    expect(config.nautilo_search_trusted_domains).toEqual(["wikipedia.org", "britannica.com"]);
    expect(config.nautilo_search_quality_mode).toBe("balanced");
    expect(config.nautilo_read_webpage_timeout_ms).toBe(30000);
    expect(config.nautilo_read_webpage_max_content_length).toBe(50000);
    expect(config.nautilo_session_auto_resume).toBe(true);
    expect(config.nautilo_session_state_file).toBe("session.json");
    expect(config.nautilo_home_root_dir).toBe("home");
    expect(config.nautilo_home_workspace_dir).toBe("home/workspace");
    expect(config.nautilo_soul_char_limit).toBe(4000);
    expect(config.nautilo_soul_generator_model).toBeNull();
    expect(config.nautilo_voice_enabled).toBe(false);
    expect(config.nautilo_voice_provider).toBe("auto");
    expect(config.nautilo_voice_name).toBeNull();
    expect(config.nautilo_log_level).toBe("info");
    expect(config.nautilo_tool_exposure_mode).toBe("progressive");
    expect(config.nautilo_tool_activation_retention_turns).toBe(3);
  });

  test("invalidates a cached environment projection after a live operator setting changes", () => {
    const previous = process.env["NAUTILO_SEARCH_PROVIDER"];
    try {
      setConfigOverrides({});
      const initial = fromRuntimeConfig().nautilo_search_provider;
      const changed = initial === "duckduckgo_html" ? "auto" : "duckduckgo_html";
      process.env["NAUTILO_SEARCH_PROVIDER"] = changed;
      expect(fromRuntimeConfig().nautilo_search_provider).toBe(initial);
      invalidateRuntimeConfigCache();
      expect(fromRuntimeConfig().nautilo_search_provider).toBe(changed);
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_SEARCH_PROVIDER"];
      else process.env["NAUTILO_SEARCH_PROVIDER"] = previous;
      invalidateRuntimeConfigCache();
    }
  });

  test("saved search provider overrides the materialized user-config default", () => {
    const previous = process.env["NAUTILO_SEARCH_PROVIDER"];
    try {
      const normalized = normalizeUserConfig({
        ...minimalUserConfig(),
        research: { searchProvider: "tavily" },
      });
      setConfigOverrides(normalized);
      process.env["NAUTILO_SEARCH_PROVIDER"] = "duckduckgo_html";

      expect(fromRuntimeConfig().nautilo_search_provider).toBe("duckduckgo_html");
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_SEARCH_PROVIDER"];
      else process.env["NAUTILO_SEARCH_PROVIDER"] = previous;
      setConfigOverrides({});
    }
  });

  test("browser decision model defaults empty when its environment setting is unset", () => {
    const previous = process.env["NAUTILO_BROWSER_DECISION_MODEL"];
    try {
      delete process.env["NAUTILO_BROWSER_DECISION_MODEL"];
      setConfigOverrides({});
      invalidateRuntimeConfigCache();

      expect(fromRuntimeConfig().nautilo_browser_decision_model).toBe("");
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_BROWSER_DECISION_MODEL"];
      else process.env["NAUTILO_BROWSER_DECISION_MODEL"] = previous;
      setConfigOverrides({});
      invalidateRuntimeConfigCache();
    }
  });

  test("reads an explicit browser decision model environment setting", () => {
    const previous = process.env["NAUTILO_BROWSER_DECISION_MODEL"];
    try {
      setConfigOverrides({});
      process.env["NAUTILO_BROWSER_DECISION_MODEL"] = "openai:browser-decider";
      invalidateRuntimeConfigCache();

      expect(fromRuntimeConfig().nautilo_browser_decision_model).toBe(
        "openai:browser-decider",
      );
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_BROWSER_DECISION_MODEL"];
      else process.env["NAUTILO_BROWSER_DECISION_MODEL"] = previous;
      setConfigOverrides({});
      invalidateRuntimeConfigCache();
    }
  });

  test("browser decision environment opt-in overrides materialized user-config defaults and an empty value rolls it back", () => {
    const previousModel = process.env["NAUTILO_BROWSER_DECISION_MODEL"];
    const previousLimit = process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"];
    try {
      const normalized = normalizeUserConfig(minimalUserConfig());
      setConfigOverrides(normalized);
      process.env["NAUTILO_BROWSER_DECISION_MODEL"] = "openrouter:typesafe/jev-1.13";
      process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"] = "3";
      invalidateRuntimeConfigCache();

      expect(fromRuntimeConfig().nautilo_browser_decision_model).toBe("openrouter:typesafe/jev-1.13");
      expect(fromRuntimeConfig().nautilo_browser_decision_intervention_limit).toBe(3);

      process.env["NAUTILO_BROWSER_DECISION_MODEL"] = "";
      delete process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"];
      invalidateRuntimeConfigCache();
      expect(fromRuntimeConfig().nautilo_browser_decision_model).toBe("");
      expect(fromRuntimeConfig().nautilo_browser_decision_intervention_limit).toBe(2);
    } finally {
      if (previousModel === undefined) delete process.env["NAUTILO_BROWSER_DECISION_MODEL"];
      else process.env["NAUTILO_BROWSER_DECISION_MODEL"] = previousModel;
      if (previousLimit === undefined) delete process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"];
      else process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"] = previousLimit;
      setConfigOverrides({});
      invalidateRuntimeConfigCache();
    }
  });

  test("browser decision intervention limit defaults to two when unset", () => {
    const previous = process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"];
    try {
      delete process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"];
      setConfigOverrides({});
      invalidateRuntimeConfigCache();

      expect(fromRuntimeConfig().nautilo_browser_decision_intervention_limit).toBe(2);
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"];
      else process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"] = previous;
      setConfigOverrides({});
      invalidateRuntimeConfigCache();
    }
  });

  test("reads browser decision intervention limits from the environment", () => {
    const previous = process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"];
    try {
      setConfigOverrides({});
      for (const [value, expected] of [["1", 1], ["3", 3]] as const) {
        process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"] = value;
        invalidateRuntimeConfigCache();

        expect(fromRuntimeConfig().nautilo_browser_decision_intervention_limit).toBe(expected);
      }
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"];
      else process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"] = previous;
      setConfigOverrides({});
      invalidateRuntimeConfigCache();
    }
  });

  test("browser decision source values apply when its environment settings are unset", () => {
    const previousModel = process.env["NAUTILO_BROWSER_DECISION_MODEL"];
    const previousLimit = process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"];
    try {
      delete process.env["NAUTILO_BROWSER_DECISION_MODEL"];
      delete process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"];
      setConfigOverrides({
        nautilo_browser_decision_model: "anthropic:configured-decider",
        nautilo_browser_decision_intervention_limit: 1,
      });

      expect(fromRuntimeConfig().nautilo_browser_decision_model).toBe("anthropic:configured-decider");
      expect(fromRuntimeConfig().nautilo_browser_decision_intervention_limit).toBe(1);
    } finally {
      if (previousModel === undefined) delete process.env["NAUTILO_BROWSER_DECISION_MODEL"];
      else process.env["NAUTILO_BROWSER_DECISION_MODEL"] = previousModel;
      if (previousLimit === undefined) delete process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"];
      else process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"] = previousLimit;
      setConfigOverrides({});
      invalidateRuntimeConfigCache();
    }
  });

  test("rejects malformed intervention environment values without truncation", () => {
    const previous = process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"];
    try {
      setConfigOverrides({});
      for (const value of ["0", "-1", "1.5", "NaN", "2events", ""]) {
        process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"] = value;
        invalidateRuntimeConfigCache();
        expect(() => fromRuntimeConfig()).toThrow();
      }
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"];
      else process.env["NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT"] = previous;
      setConfigOverrides({});
      invalidateRuntimeConfigCache();
    }
  });

  test("rejects invalid browser decision intervention limits", () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        fromRuntimeConfig({ nautilo_browser_decision_intervention_limit: limit }),
      ).toThrow();
    }
  });

  test("audit initial-wait policy accepts sectioned config and an instance override", () => {
    const previous = process.env["NAUTILO_RESEARCH_FIRST_PROGRESS_TIMEOUT_MS"];
    try {
      delete process.env["NAUTILO_RESEARCH_FIRST_PROGRESS_TIMEOUT_MS"];
      setConfigOverrides(normalizeUserConfig(minimalUserConfig()));
      expect(fromRuntimeConfig().nautilo_research_first_progress_timeout_ms).toBe(600_000);
      setConfigOverrides(normalizeUserConfig({ ...minimalUserConfig(), research: { auditFirstProgressTimeoutMs: 420_000 } }));
      expect(fromRuntimeConfig().nautilo_research_first_progress_timeout_ms).toBe(420_000);
      process.env["NAUTILO_RESEARCH_FIRST_PROGRESS_TIMEOUT_MS"] = "900000";
      invalidateRuntimeConfigCache();
      expect(fromRuntimeConfig().nautilo_research_first_progress_timeout_ms).toBe(900_000);
      expect(() => normalizeUserConfig({ ...minimalUserConfig(), research: { auditFirstProgressTimeoutMs: 0 } })).toThrow();
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_RESEARCH_FIRST_PROGRESS_TIMEOUT_MS"];
      else process.env["NAUTILO_RESEARCH_FIRST_PROGRESS_TIMEOUT_MS"] = previous;
      setConfigOverrides({});
      invalidateRuntimeConfigCache();
    }
  });

  test("explicit OpenConnector environment binding overrides a materialized user-config default", () => {
    const previous = process.env["NAUTILO_OPENCONNECTOR_BASE_URL"];
    try {
      setConfigOverrides(normalizeUserConfig(minimalUserConfig()));
      process.env["NAUTILO_OPENCONNECTOR_BASE_URL"] = "http://localhost:37656";

      expect(fromRuntimeConfig().nautilo_openconnector_base_url).toBe(
        "http://localhost:37656",
      );
    } finally {
      if (previous === undefined) {
        delete process.env["NAUTILO_OPENCONNECTOR_BASE_URL"];
      } else {
        process.env["NAUTILO_OPENCONNECTOR_BASE_URL"] = previous;
      }
      setConfigOverrides({});
    }
  });

  test("normalizes persisted tool activation retention values", () => {
    for (const activationRetentionTurns of [0, 3, 20]) {
      expect(
        normalizeUserConfig(minimalUserConfig({ activationRetentionTurns }))
          .nautilo_tool_activation_retention_turns,
      ).toBe(activationRetentionTurns);
    }
  });

  test("defaults omitted persisted tool activation retention to three turns", () => {
    expect(
      normalizeUserConfig(minimalUserConfig()).nautilo_tool_activation_retention_turns,
    ).toBe(3);
  });

  test("supports internal tool activation retention runtime overrides", () => {
    expect(
      fromRuntimeConfig({ nautilo_tool_activation_retention_turns: 20 })
        .nautilo_tool_activation_retention_turns,
    ).toBe(20);
  });

  test("rejects invalid persisted tool activation retention values", () => {
    for (const activationRetentionTurns of [-1, 3.5, "3", Number.NaN, 21]) {
      expect(() =>
        normalizeUserConfig(minimalUserConfig({ activationRetentionTurns })),
      ).toThrow();
    }
  });

  test("tool activation retention has no environment override", () => {
    const previous = process.env["NAUTILO_TOOL_ACTIVATION_RETENTION_TURNS"];
    process.env["NAUTILO_TOOL_ACTIVATION_RETENTION_TURNS"] = "20";

    try {
      setConfigOverrides(
        normalizeUserConfig(minimalUserConfig({ activationRetentionTurns: 0 })),
      );
      expect(fromRuntimeConfig().nautilo_tool_activation_retention_turns).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env["NAUTILO_TOOL_ACTIVATION_RETENTION_TURNS"];
      } else {
        process.env["NAUTILO_TOOL_ACTIVATION_RETENTION_TURNS"] = previous;
      }
      setConfigOverrides({});
    }
  });

  test("exposes eager selection as an explicit temporary rollback only", () => {
    expect(
      fromRuntimeConfig({ nautilo_tool_exposure_mode: "eager" })
        .nautilo_tool_exposure_mode,
    ).toBe("eager");
    expect(
      fromRuntimeConfig({ nautilo_tool_exposure_mode: "progressive" })
        .nautilo_tool_exposure_mode,
    ).toBe("progressive");
  });

  test("rejects invalid tool exposure modes", () => {
    expect(() =>
      fromRuntimeConfig({
        // @ts-expect-error — testing runtime rejection of an invalid rollback mode.
        nautilo_tool_exposure_mode: "all_tools",
      }),
    ).toThrow();
  });

  test("runtime overrides win over defaults", () => {
    const config = fromRuntimeConfig({ nautilo_model: "openai:gpt-5.5-2026-04-23" });
    expect(config.nautilo_model).toBe("openai:gpt-5.5-2026-04-23");
  });

  test("setConfigOverrides persists for subsequent calls", () => {
    setConfigOverrides({ nautilo_log_level: "debug" });
    const config = fromRuntimeConfig();
    expect(config.nautilo_log_level).toBe("debug");
    setConfigOverrides({});
  });

  // -------------------------------------------------------------------------
  // Security posture — Sprint 1 G5.3
  // -------------------------------------------------------------------------

  test("defaults: deployment_mode=desktop-permissive, level=standard", () => {
    setConfigOverrides({});
    const config = fromRuntimeConfig();
    expect(config.nautilo_deployment_mode).toBe("desktop-permissive");
    expect(config.nautilo_security_level).toBe("standard");
  });

  test("resolveServerPosture exposes the security slice", () => {
    setConfigOverrides({
      nautilo_deployment_mode: "server",
      nautilo_security_level: "paranoid",
    });
    const posture = resolveServerPosture();
    expect(posture.deploymentMode).toBe("server");
    expect(posture.securityLevel).toBe("paranoid");
    setConfigOverrides({});
  });

  test("normalizeUserConfig: sectioned security block → flat runtime fields", () => {
    const normalized = normalizeUserConfig({
      models: {
        default: "anthropic:claude-sonnet-4-6",
        sessionSearch: "fireworks:accounts/fireworks/models/minimax-m3",
        flush: "fireworks:accounts/fireworks/models/glm-5p2",
        reviewer: "fireworks:accounts/fireworks/models/glm-5p2",
        webSearch: "fireworks:accounts/fireworks/models/minimax-m3",
        embedding: { model: "text-embedding-3-small", dimensions: 1536 },
      },
      memory: {},
      history: {},
      research: {},
      session: {},
      home: {},
      storage: {},
      soul: {},
      voice: {},
      logging: {},
      security: { level: "paranoid", deploymentMode: "server" },
    });
    expect(normalized.nautilo_deployment_mode).toBe("server");
    expect(normalized.nautilo_security_level).toBe("paranoid");
  });

  test("normalizeUserConfig: missing security block → defaults applied", () => {
    const normalized = normalizeUserConfig({
      models: {
        default: "anthropic:claude-sonnet-4-6",
        sessionSearch: "fireworks:accounts/fireworks/models/minimax-m3",
        flush: "fireworks:accounts/fireworks/models/glm-5p2",
        reviewer: "fireworks:accounts/fireworks/models/glm-5p2",
        webSearch: "fireworks:accounts/fireworks/models/minimax-m3",
        embedding: { model: "text-embedding-3-small", dimensions: 1536 },
      },
      memory: {},
      history: {},
      research: {},
      session: {},
      home: {},
      storage: {},
      soul: {},
      voice: {},
      logging: {},
      // security intentionally omitted — pre-G5.3 user configs.
    });
    expect(normalized.nautilo_deployment_mode).toBe("desktop-permissive");
    expect(normalized.nautilo_security_level).toBe("standard");
  });

  test("rejects invalid deployment_mode values (no silent coercion)", () => {
    expect(() =>
      fromRuntimeConfig({
        // @ts-expect-error — testing runtime rejection of an invalid value.
        nautilo_deployment_mode: "yolo",
      }),
    ).toThrow();
  });

  test("normalizes sectioned user config into flat runtime config", () => {
    const normalized = normalizeUserConfig({
      models: {
        default: "openai:gpt-5.5-2026-04-23",
        sessionSearch: "fireworks:accounts/fireworks/models/minimax-m3",
        flush: "fireworks:accounts/fireworks/models/glm-5p2",
        reviewer: "fireworks:accounts/fireworks/models/glm-5p2",
        webSearch: "fireworks:accounts/fireworks/models/minimax-m3",
        embedding: { model: "text-embedding-3-small", dimensions: 1536 },
      },
      memory: {
        briefCharLimit: 1500,
        searchLimit: 7,
        sessionSearchLimit: 3,
        dedupSimilarityThreshold: 0.95,
        exitFlushEnabled: true,
        flushMinTurns: 4,
        nudgeThreshold: 12,
        reviewerEnabled: true,
        reviewerMaxIterations: 6,
      },
      history: {
        validationEnabled: true,
        pruningEnabled: false,
        tokenBudgetFraction: 0.5,
        windowKeepRecent: 15,
      },
      research: {
        searchProvider: "tavily",
        searchMaxResults: 7,
        searchDepth: "advanced",
        searchReadPageCount: 3,
        readWebpageTimeoutMs: 25000,
        readWebpageMaxContentLength: 40000,
        searchExcludeDomains: ["reddit.com", "quora.com"],
        searchTrustedDomains: ["wikipedia.org"],
        searchQualityMode: "strict",
      },
      session: { autoResume: false, stateFile: "custom-session.json" },
      home: {
        rootDir: "custom-home",
        workspaceDir: "custom-home/workspace",
        researchDir: "custom-home/research",
        notesDir: "custom-home/notes",
        exportsDir: "custom-home/exports",
        logsDir: "custom-home/logs",
        transcriptsDir: "custom-home/transcripts",
      },
      storage: {
        scratchDir: "custom-scratch",
        dataDir: "custom-data",
        dbDataDir: "custom-data/db",
        embeddingsDir: "custom-data/embeddings",
        voiceCacheDir: "custom-data/voice-previews",
        audioCacheDir: "custom-data/audio",
        vaultDir: "custom-vault",
      },
      soul: { charLimit: 1800, generatorModel: "openai:gpt-5.5-2026-04-23" },
      voice: { enabled: true, provider: "elevenlabs", voiceName: "Carolyn", speakToolSummaries: false },
      logging: { toolCalls: false, level: "warn", historyOperations: true },
    });

    expect(normalized.nautilo_model).toBe("openai:gpt-5.5-2026-04-23");
    expect(normalized.nautilo_memory_brief_char_limit).toBe(1500);
    expect(normalized.nautilo_memory_search_limit).toBe(7);
    expect(normalized.nautilo_memory_dedup_similarity_threshold).toBe(0.95);
    expect(normalized.nautilo_search_max_results).toBe(7);
    expect(normalized.nautilo_search_depth).toBe("advanced");
    expect(normalized.nautilo_search_exclude_domains).toEqual(["reddit.com", "quora.com"]);
    expect(normalized.nautilo_search_trusted_domains).toEqual(["wikipedia.org"]);
    expect(normalized.nautilo_search_quality_mode).toBe("strict");
    expect(normalized.nautilo_session_auto_resume).toBe(false);
    expect(normalized.nautilo_soul_char_limit).toBe(1800);
    expect(normalized.nautilo_voice_enabled).toBe(true);
    expect(normalized.nautilo_voice_provider).toBe("elevenlabs");
    expect(normalized.nautilo_log_level).toBe("warn");
    expect(normalized.nautilo_scratch_dir).toBe("custom-scratch");
    expect(normalized.nautilo_data_dir).toBe("custom-data");
    expect(normalized.nautilo_vault_dir).toBe("custom-vault");
    expect(normalized.nautilo_voice_cache_dir).toBe("custom-data/voice-previews");
    expect(normalized.nautilo_audio_cache_dir).toBe("custom-data/audio");
  });
});
