import { describe, expect, test } from "bun:test";
import { LOCAL_FILE_EXECUTION_UNSUPPORTED } from "@nautilo/relay";
import type { RelayDispatchResult } from "@nautilo/relay";
import type { RelayCapabilities } from "@nautilo/relay";
import type { ToolRelayRegistry } from "../../src/nodes/tools";
import { resolveLocalOfficeRelay } from "../../src/tools/office/local-office-routing";

const OWNER = "00000000-0000-4000-8000-000000000001";

function makeRegistry(
  caps: Partial<RelayCapabilities>,
  protocolVersion = 4,
  relayIds: readonly string[] = ["relay-1"],
): ToolRelayRegistry {
  const full: RelayCapabilities = {
    profile: "desktop-agent",
    canReadWorkspace: true,
    canWriteWorkspace: true,
    localFileExecution: true,
    canRunOffice: true,
    allowedRoots: ["/tmp"],
    ...caps,
  };
  return {
    findByCapabilityForUser(capability: string): string[] {
      return (full as unknown as Record<string, unknown>)[capability] === true
        ? [...relayIds]
        : [];
    },
    getCapabilities(): RelayCapabilities {
      return full;
    },
    getProtocolVersion(): number {
      return protocolVersion;
    },
    async dispatch(): Promise<RelayDispatchResult> {
      return { status: "error", error: "not used" };
    },
    async localFileDispatch() {
      return { ok: true, result: {} };
    },
  };
}

describe("resolveLocalOfficeRelay (M206 Phase 3)", () => {
  test("characterizes the unsafe first-eligible multi-host fallback D458 must remove", () => {
    const sel = resolveLocalOfficeRelay({
      ownerId: OWNER,
      mutating: false,
      registry: makeRegistry({}, 4, ["mac-a", "mac-b"]),
    });

    expect(sel.ok).toBe(true);
    if (sel.ok) expect(sel.relayId).toBe("mac-a");
  });

  test("fails closed without canRunOffice", () => {
    const sel = resolveLocalOfficeRelay({
      ownerId: OWNER,
      mutating: false,
      registry: makeRegistry({ canRunOffice: false }),
    });
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.code).toBe(LOCAL_FILE_EXECUTION_UNSUPPORTED);
      expect(sel.error).toContain("OfficeCLI");
    }
  });

  test("selects a v4 relay when localFileExecution and canRunOffice are set", () => {
    const sel = resolveLocalOfficeRelay({
      ownerId: OWNER,
      mutating: true,
      registry: makeRegistry({}),
    });
    expect(sel.ok).toBe(true);
    if (sel.ok) expect(sel.relayId).toBe("relay-1");
  });
});
