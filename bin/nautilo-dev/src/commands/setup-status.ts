/**
 * D112 Phase 5.1 — dev CLI surface for `GET /api/setup/status`.
 * Parity with the future shipped `nautilo status` (D094); lives on
 * `nautilo-dev` until the product CLI lands.
 */
import {
  formatSetupStatusHuman,
  NautiloApiClient,
  resolveCliServerUrl,
} from "@nautilo/api-client";

function parseFormat(args: string[]): "human" | "json" {
  const idx = args.indexOf("--format");
  if (idx === -1 || idx === args.length - 1) return "human";
  const v = args[idx + 1]!.toLowerCase();
  return v === "json" ? "json" : "human";
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

/** Exit 0 only when `setupState === "ready"` (D112 Phase 5.1 contract). */
export async function setupStatusCmd(args: string[]): Promise<number> {
  const baseUrl = resolveCliServerUrl({ serverFlag: flagValue(args, "--server") });
  const format = parseFormat(args);
  const client = new NautiloApiClient(baseUrl);

  let body;
  try {
    body = await client.getSetupStatus();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (format === "json") {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
      console.error(`Failed to fetch setup status from ${baseUrl}: ${msg}`);
    }
    return 2;
  }

  if (format === "json") {
    console.log(JSON.stringify(body, null, 2));
  } else {
    process.stdout.write(formatSetupStatusHuman(baseUrl, body));
  }

  return body.setupState === "ready" ? 0 : 2;
}
