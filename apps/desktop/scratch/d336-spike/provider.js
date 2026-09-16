#!/usr/bin/env node

const fs = require("node:fs");

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const port = process.env.D336_SPIKE_PORT || "47736";
const token = process.env.D336_SPIKE_TOKEN || "d336-spike-token";
const cdpUrl = `ws://127.0.0.1:${port}/${token}`;

function write(body) {
  process.stdout.write(JSON.stringify({
    protocol: "agent-browser.plugin.v1",
    success: true,
    ...body,
  }));
}

if (input.protocol !== "agent-browser.plugin.v1") {
  process.stdout.write(JSON.stringify({
    protocol: "agent-browser.plugin.v1",
    success: false,
    error: "unsupported protocol",
  }));
  process.exit(0);
}

if (input.type === "plugin.manifest") {
  write({
    manifest: {
      name: "nautilo-spike",
      capabilities: ["browser.provider"],
      description: "D336 Nautilo embedded WebContentsView CDP direct-page spike",
    },
  });
  process.exit(0);
}

if (input.type === "browser.launch") {
  write({
    browser: {
      cdpUrl,
      directPage: true,
      metadata: { source: "d336-spike" },
    },
  });
  process.exit(0);
}

if (input.type === "browser.close") {
  write({ data: {} });
  process.exit(0);
}

process.stdout.write(JSON.stringify({
  protocol: "agent-browser.plugin.v1",
  success: false,
  error: `unsupported request type: ${input.type}`,
}));
