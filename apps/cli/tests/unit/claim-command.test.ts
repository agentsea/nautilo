import { describe, expect, test } from "bun:test";

import { createServerAdminCli } from "../../src/server-admin-index.ts";

describe("claim resume command", () => {
  test("standalone parser exposes the real nested resume command and its finish/browser contract", async () => {
    const cli = createServerAdminCli({ argv: ["claim", "resume"] });
    const help = await cli.getHelp();
    expect(help).toContain("nautilo claim resume");
    expect(help).toContain("--finish");
    expect(help).toContain("--open-browser");
    expect(help).toContain("--json");
  });
});
