/**
 * Nautilo configuration file.
 *
 * Sections map to the NautiloUserConfigSchema in @nautilo/config.
 * Secrets (API keys) stay in .env — never put them here.
 */
const config = {
  // Empty selections use credential-aware role defaults; instance overrides remain explicit.
  models: {
    default: "",
    sessionSearch: "",
    flush: "",
    reviewer: "",
    webSearch: "",
    embedding: {
      model: "",
      dimensions: 1536,
    },
  },

  memory: {
    briefCharLimit: 2000,
    searchLimit: 10,
    sessionSearchLimit: 5,
    dedupSimilarityThreshold: 0.9,
    exitFlushEnabled: true,
    flushMinTurns: 3,
    nudgeThreshold: 10,
    reviewerEnabled: true,
    reviewerMaxIterations: 8,
  },

  research: {
    searchProvider: "auto" as const,
    searchMaxResults: 5,
    searchDepth: "basic" as const,
    searchReadPageCount: 2,
    readWebpageTimeoutMs: 30_000,
    readWebpageMaxContentLength: 50_000,
    searchExcludeDomains: [
      "reddit.com",
      "facebook.com",
      "quora.com",
      "pinterest.com",
      "tiktok.com",
    ],
    searchTrustedDomains: ["wikipedia.org", "britannica.com"],
    searchQualityMode: "balanced" as const,
  },

  history: {
    validationEnabled: true,
    pruningEnabled: false,
    tokenBudgetFraction: 0.6,
    windowKeepRecent: 20,
  },

  session: {
    autoResume: true,
    stateFile: "session.json",
  },

  home: {
    rootDir: "home",
    workspaceDir: "home/workspace",
    researchDir: "home/research",
    notesDir: "home/notes",
    exportsDir: "home/exports",
    logsDir: "home/logs",
    transcriptsDir: "home/transcripts",
  },

  // Zone roots and app-internal data paths (D049 artifact-centric pivot).
  // `scratch/` is a SIBLING of `home/`, not a child — enables cleaning
  // ephemeral tool output without risking permanent work product.
  // `data/*` and `vault/` are app-internal; the relay never receives
  // providers for these zones (v8 §9.1 key-isolation).
  //
  // No `inboxDir` — async ingestion (email / mobile / scanner) is
  // deferred to ISSUE-D068 until real adapters ship.
  storage: {
    scratchDir: "scratch",
    dataDir: "data",
    dbDataDir: "data/db",
    embeddingsDir: "data/embeddings",
    voiceCacheDir: "data/voice-previews",
    audioCacheDir: "data/audio",
    vaultDir: "vault",
  },

  soul: {
    charLimit: 4000,
    generatorModel: null,
    motherEasterEgg: false, // Set to true for a Her-inspired bonus question during setup
  },

  voice: {
    enabled: true,
    provider: "elevenlabs" as const,
    voiceName: "carolyn",
    speakToolSummaries: false,
  },

  logging: {
    toolCalls: true,
    level: "info" as const,
    historyOperations: false,
  },

  tools: {
    activationRetentionTurns: 3,
  },

  // M071 — optional instance network/hostname overlay (see ISSUE-M071).
  // Values normalize into `nautilo_instance_network` / `nautilo_instance_hostname`
  // and merge into `resolveInstance()` below env overrides, above disk `instance.json`.
  //
  // network: {
  //   serverPort: 3001,
  //   workbenchPort: 3000,
  //   dbPostgresHostPort: 5434,
  //   logtoDbPort: 5432,
  //   logtoCorePort: 3301,
  //   logtoAdminPort: 3302,
  //   composeProjectName: "nautilo",
  // },
  //
  // hostname: {
  //   federated: "nautilo.local",
  //   mdns: "nautilo.local",
  //   tlsSan: "",
  //   caddyAuthHost: "auth.nautilo.local",
  //   caddyAuthAdminHost: "auth-admin.nautilo.local",
  // },
};

export default config;
