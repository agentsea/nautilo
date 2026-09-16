import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  REVIEWED_MAIN_2026_08_04_COVERAGE_ENTRIES,
  REVIEWED_MAIN_2026_08_04_DEBT_LINKS,
} from "../../baseline/reviewed-main-2026-08-04";

const repositoryRoot = join(import.meta.dir, "../../../..");

describe("reviewed 2026-08-04 main security boundaries", () => {
  test("keeps remote host file projections on the existing Relay file debt", () => {
    const hostFileLocators = new Set([
      "http:request_response:POST /api/remote/current-folder/select",
      "http:request_response:POST /api/remote/host-files/list",
      "http:request_response:POST /api/remote/host-files/read",
      "http:request_response:POST /api/remote/host-files/stat",
    ]);
    const links = REVIEWED_MAIN_2026_08_04_DEBT_LINKS.filter((entry) =>
      hostFileLocators.has(entry.locator)
    );

    expect(links).toHaveLength(hostFileLocators.size);
    expect(new Set(links.map((entry) => entry.locator))).toEqual(
      hostFileLocators,
    );
    expect(links.every((entry) =>
      entry.targetDebtIds.includes(
        "debt.wire.relay.declared.arbitrary.packages.relay.src.protocol.ts.relaylocalfileresult.14trnr5",
      )
    )).toBe(true);
  });

  test("classifies plaintext ceremony and Electron credentials as ephemeral secrets", () => {
    const secretLocators = new Set([
      "http:request_response:POST /api/relay/electron-origin-credential",
      "http:request_response:POST /api/remote/challenges",
      "http:request_response:POST /api/remote/challenges/manual/prepare",
    ]);
    const entries = REVIEWED_MAIN_2026_08_04_COVERAGE_ENTRIES.filter((entry) =>
      secretLocators.has(entry.locator)
    );

    expect(entries).toHaveLength(secretLocators.size);
    expect(entries.every((entry) =>
      entry.classification === "operator_secret"
      && entry.excludedFromAgentGrants
      && entry.backupProcedure.includes("Not backed up")
    )).toBe(true);
  });

  test("does not log raw exceptions from the newly reviewed control paths", async () => {
    const forbiddenByPath = new Map<string, readonly string[]>([
      [
        "packages/agent/src/graph/resume-host-choice.ts",
        ["error.message", "String(error)"],
      ],
      [
        "packages/server/src/app.ts",
        [
          "admission audit write failed for ${event.toolName}: ",
          "admission audit write failed for ${event.toolName}: ${err instanceof Error ? err.message : String(err)}",
        ],
      ],
      [
        "packages/server/src/realtime/relay-endpoint.ts",
        ["WebSocket error for ${registeredRelayId ?? \"unregistered\"}: ${err.message}"],
      ],
      [
        "packages/server/src/routes/auth.ts",
        [
          "[auth/approval-reply] audit write failed for ${event.kind}: ${String(err)}",
        ],
      ],
      [
        "packages/server/src/routes/remote-control.ts",
        ["detail: error.message"],
      ],
      [
        "packages/server/src/routes/ws.ts",
        ["maintenance.status snapshot skipped on connect: ${"],
      ],
    ]);

    for (const [path, forbidden] of forbiddenByPath) {
      const source = await readFile(join(repositoryRoot, path), "utf8");
      for (const fragment of forbidden) expect(source).not.toContain(fragment);
    }
  });
});
