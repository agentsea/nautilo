import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { isCloudMode } from "@nautilo/config";

test("cloud mode: persistent provider authority wins over stale platform env", () => {
  const dir = mkdtempSync(join(tmpdir(), "nautilo-cloud-boot-"));
  // Capture pre-test values so the cleanup can restore (NOT delete) them —
  // a dev running `bun test` in a shell with a real OPENAI_API_KEY set
  // would otherwise have it wiped for the rest of the bun process.
  const origMode = process.env["NAUTILO_HOSTING_MODE"];
  const origKey = process.env["OPENAI_API_KEY"];
  const origOpenRouter = process.env["OPENROUTER_API_KEY"];
  try {
    process.env["NAUTILO_HOSTING_MODE"] = "cloud";
    process.env["OPENAI_API_KEY"] = "env-injected";
    process.env["OPENROUTER_API_KEY"] = "platform-rotated";
    writeFileSync(join(dir, "instance.env"), "OPENAI_API_KEY=stale-file-value\n");
    loadDotenv({ path: join(dir, "instance.env"), override: isCloudMode() });
    expect(process.env["OPENAI_API_KEY"]).toBe("stale-file-value");
    expect(process.env["OPENROUTER_API_KEY"]).toBe("platform-rotated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (origMode === undefined) delete process.env["NAUTILO_HOSTING_MODE"];
    else process.env["NAUTILO_HOSTING_MODE"] = origMode;
    if (origKey === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = origKey;
    if (origOpenRouter === undefined) delete process.env["OPENROUTER_API_KEY"];
    else process.env["OPENROUTER_API_KEY"] = origOpenRouter;
  }
});
