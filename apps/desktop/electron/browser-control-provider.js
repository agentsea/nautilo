#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const statePath =
  argValue("--state") ||
  process.env.NAUTILO_BROWSER_CONTROL_STATE ||
  path.join(os.homedir(), "Library", "Application Support", "Nautilo", "browser-control-state.json");

function respond(body) {
  process.stdout.write(JSON.stringify({
    protocol: "agent-browser.plugin.v1",
    ...body,
  }));
}

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

function readState() {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (state?.version !== 1 || !Array.isArray(state.views)) {
    throw new Error("invalid browser control state");
  }
  return state;
}

const input = readInput();
if (input.protocol !== "agent-browser.plugin.v1") {
  respond({ success: false, error: "unsupported protocol" });
  process.exit(0);
}

if (input.type === "plugin.manifest") {
  respond({
    success: true,
    manifest: {
      name: "nautilo-browser",
      capabilities: ["browser.provider"],
      description: "Nautilo managed SaaS browser view provider",
    },
  });
  process.exit(0);
}

if (input.type === "browser.launch") {
  try {
    const state = readState();
    const view =
      state.views.find((candidate) => candidate.appId === state.activeAppId) ||
      state.views.find((candidate) => candidate.visible && candidate.state === "hot" && candidate.cdpUrl);
    if (!view?.cdpUrl) {
      respond({ success: false, error: "no active Nautilo browser view" });
      process.exit(0);
    }
    respond({
      success: true,
      browser: {
        cdpUrl: view.cdpUrl,
        directPage: true,
        metadata: {
          appId: view.appId,
          source: "nautilo-browser-control",
        },
      },
    });
  } catch (err) {
    respond({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  process.exit(0);
}

if (input.type === "browser.close") {
  respond({ success: true, data: {} });
  process.exit(0);
}

respond({ success: false, error: `unsupported request type: ${input.type}` });
