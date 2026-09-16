import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { SERVER_FINISH_MODES } from "../../src/lib/server-completion.ts";

const CLI_ROOT = resolve(import.meta.dir, "../..");
const REPO_ROOT = resolve(CLI_ROOT, "../..");

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

describe("server completion adapter boundary", () => {
  test("CLI and Workbench retain the same closed finish vocabulary", () => {
    const handoff = source("apps/workbench/src/lib/owner-claim-handoff.ts");
    const match = handoff.match(
      /OWNER_CLAIM_FINISH_MODES\s*=\s*\["([^"]+)",\s*"([^"]+)"\]/,
    );
    expect(match?.slice(1)).toEqual([...SERVER_FINISH_MODES]);

    const sharedHandoff = source("apps/cli/src/lib/owner-claim-handoff.ts");
    const railwayHandoff = source("apps/cli/src/lib/railway-owner-claim-handoff.ts");
    expect(sharedHandoff).toContain("new URLSearchParams({ claim: input.claim, finish: input.finish })");
    expect(`${sharedHandoff}\n${railwayHandoff}`).not.toContain("receipt");
    expect(`${sharedHandoff}\n${railwayHandoff}`).not.toContain("bootstrapToken");
  });

  test("both adapters consume the pure summary without moving authority into it", () => {
    const helper = source("apps/cli/src/lib/server-completion.ts");
    const compose = source("apps/cli/src/commands/deploy.ts");
    const railway = source("apps/cli/src/commands/host.ts");

    expect(compose).toContain("buildServerCompletionSummary");
    expect(railway).toContain("buildServerCompletionSummary");
    expect(helper).not.toMatch(/@nautilo\/(compose-driver|railway-hosting)/);
    expect(helper).not.toMatch(/Keyring|claimHash|bootstrapToken|providerCustody|receipt/);
    expect(helper).not.toContain("if (input.backend");
    expect(helper).not.toContain("switch (input.backend");
  });

  test("the public server-admin graph keeps legacy setup out", () => {
    const entry = source("apps/cli/src/server-admin-index.ts");
    const allowlist = entry.slice(
      entry.indexOf("SERVER_ADMIN_COMMAND_ALLOWLIST"),
      entry.indexOf("] as const", entry.indexOf("SERVER_ADMIN_COMMAND_ALLOWLIST")),
    );
    expect(allowlist).toContain('"deploy"');
    expect(allowlist).toContain('"host adopt|plan|deploy|upgrade|resume|inspect|destroy"');
    expect(allowlist).not.toMatch(/(^|["\s])setup(["\s,]|$)/m);
  });
});
