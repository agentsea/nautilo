/**
 * `list` command — print the test catalog.
 */

import type { Platform, TestLayer } from "@nautilo/smoke-runner";
import { getString, type ParsedArgs } from "../lib/args.ts";
import { loadExpectations } from "../lib/factory.ts";

export async function listCommand(args: ParsedArgs): Promise<number> {
  const platformArg = getString(args, "platform", "both");
  const layerArg = typeof args.flags["layer"] === "string" ? args.flags["layer"] : undefined;
  const pattern = typeof args.flags["pattern"] === "string" ? args.flags["pattern"] : undefined;

  const expectations = await loadExpectations();
  const platforms: Platform[] =
    platformArg === "linux" ? ["linux"]
      : platformArg === "macos" ? ["macos"]
      : ["linux", "macos"];

  console.log(`# Smoke test catalog (platforms: ${platforms.join(",")})`);
  console.log("");
  console.log("ID          Platform  Layer              Description");
  console.log("----------  --------  -----------------  ---------------------------------------");
  for (const platform of platforms) {
    const specs = expectations.list({
      platform,
      ...(layerArg !== undefined ? { layer: layerArg as TestLayer } : {}),
      ...(pattern !== undefined ? { pattern } : {}),
    });
    for (const s of specs) {
      const id = s.id.padEnd(10);
      const plat = s.platform.padEnd(8);
      const layer = s.layer.padEnd(17);
      console.log(`${id}  ${plat}  ${layer}  ${s.description}`);
    }
  }
  return 0;
}
