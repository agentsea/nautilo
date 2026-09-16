import { describe, test, expect } from "bun:test";
import { interruptValueToServerEvent } from "../../src/executors/langgraph-executor";

describe("interruptValueToServerEvent — interrupt → WS event dispatch", () => {
  // -------------------------------------------------------------------------
  // Null / malformed
  // -------------------------------------------------------------------------

  describe("null / malformed inputs", () => {
    test("undefined value → null", () => {
      expect(interruptValueToServerEvent(undefined, "t1", "l1")).toBeNull();
    });

    test("empty object → null", () => {
      expect(interruptValueToServerEvent({}, "t1", "l1")).toBeNull();
    });

    test("unknown type → null", () => {
      expect(interruptValueToServerEvent({ type: "some_new_thing" }, "t1", "l1")).toBeNull();
    });

    test("missing type → null", () => {
      expect(interruptValueToServerEvent({ tools: [] }, "t1", "l1")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // identity_challenge → identity.challenge
  // -------------------------------------------------------------------------

  describe("identity_challenge", () => {
    test("maps to identity.challenge with execution context", () => {
      const ev = interruptValueToServerEvent(
        {
          type: "identity_challenge",
          challengeId: "chal-abc",
          expiresAt: "2026-04-20T12:00:00Z",
        },
        "thread-1",
        "lane-1",
      );

      expect(ev).not.toBeNull();
      expect(ev!.type).toBe("identity.challenge");
      if (ev?.type === "identity.challenge") {
        expect(ev.threadId).toBe("thread-1");
        expect(ev.laneKey).toBe("lane-1");
        expect(ev.challengeId).toBe("chal-abc");
        expect(ev.expiresAt).toBe("2026-04-20T12:00:00Z");
      }
    });

    test("missing challengeId / expiresAt → empty strings, not crashes", () => {
      const ev = interruptValueToServerEvent(
        { type: "identity_challenge" },
        "thread-1",
        "lane-1",
      );
      expect(ev).not.toBeNull();
      if (ev?.type === "identity.challenge") {
        expect(ev.challengeId).toBe("");
        expect(ev.expiresAt).toBe("");
      }
    });

    // M054 — `mode` is forwarded when present so the workbench's
    // identity.challenge handler can branch on `verify` vs `enrollPin`.
    test("forwards mode='enrollPin' when set on the interrupt payload", () => {
      const ev = interruptValueToServerEvent(
        { type: "identity_challenge", mode: "enrollPin" },
        "thread-1",
        "lane-1",
      );
      expect(ev).not.toBeNull();
      if (ev?.type === "identity.challenge") {
        expect(ev.mode).toBe("enrollPin");
      }
    });

    test("forwards mode='verify' when explicitly set", () => {
      const ev = interruptValueToServerEvent(
        { type: "identity_challenge", mode: "verify" },
        "thread-1",
        "lane-1",
      );
      if (ev?.type === "identity.challenge") {
        expect(ev.mode).toBe("verify");
      }
    });

    test("missing mode → omitted from event (back-compat with pre-M054 servers)", () => {
      const ev = interruptValueToServerEvent(
        { type: "identity_challenge" },
        "thread-1",
        "lane-1",
      );
      if (ev?.type === "identity.challenge") {
        expect(ev.mode).toBeUndefined();
      }
    });

    test("garbage mode value → omitted (defensive)", () => {
      const ev = interruptValueToServerEvent(
        { type: "identity_challenge", mode: "trojan" },
        "thread-1",
        "lane-1",
      );
      if (ev?.type === "identity.challenge") {
        expect(ev.mode).toBeUndefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // prove_it_challenge → prove_it.challenge (M036)
  // -------------------------------------------------------------------------

  describe("prove_it_challenge", () => {
    test("maps to prove_it.challenge with tools preserved", () => {
      const tools = [{ name: "run_shell", args: { command: "sudo rm -rf ~/Documents" }, id: "tc-1" }];
      const ev = interruptValueToServerEvent(
        { type: "prove_it_challenge", tools },
        "thread-2",
        "lane-2",
      );

      expect(ev).not.toBeNull();
      expect(ev!.type).toBe("prove_it.challenge");
      if (ev?.type === "prove_it.challenge") {
        expect(ev.threadId).toBe("thread-2");
        expect(ev.laneKey).toBe("lane-2");
        expect(ev.tools).toEqual(tools);
      }
    });

    test("missing tools → empty array, not crash", () => {
      const ev = interruptValueToServerEvent(
        { type: "prove_it_challenge" },
        "thread-2",
        "lane-2",
      );
      expect(ev).not.toBeNull();
      if (ev?.type === "prove_it.challenge") {
        expect(ev.tools).toEqual([]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // approval_ask → approval.ask (D061 Phase 2)
  // -------------------------------------------------------------------------

  describe("approval_ask (D061 Phase 2)", () => {
    test("maps to approval.ask with full payload preserved", () => {
      const tools = [{ name: "run_shell", args: { command: "npm install -g typescript" }, id: "tc-x" }];
      const ev = interruptValueToServerEvent(
        {
          type: "approval_ask",
          approvalId: "approval-1",
          tools,
          reason: "Global npm install (medium severity) — needs approval (severity: destructive-medium)",
          reasonCode: "command-scanner-medium",
          allowedVerbs: ["once", "room", "always", "deny"],
        },
        "thread-3",
        "lane-3",
      );

      expect(ev).not.toBeNull();
      expect(ev!.type).toBe("approval.ask");
      if (ev?.type === "approval.ask") {
        expect(ev.approvalId).toBe("approval-1");
        expect(ev.threadId).toBe("thread-3");
        expect(ev.laneKey).toBe("lane-3");
        expect(ev.tools).toEqual(tools);
        expect(ev.reason).toContain("Global npm install");
        expect(ev.reasonCode).toBe("command-scanner-medium");
        expect(ev.allowedVerbs).toEqual(["once", "room", "always", "deny"]);
      }
    });

    test("missing optional fields default to safe values", () => {
      const ev = interruptValueToServerEvent(
        { type: "approval_ask" },
        "thread-3",
        "lane-3",
      );

      expect(ev).not.toBeNull();
      if (ev?.type === "approval.ask") {
        expect(ev.tools).toEqual([]);
        expect(ev.reason).toBe("");
        expect(ev.reasonCode).toBe("destructive-tool"); // default
        expect(ev.allowedVerbs).toEqual(["once", "room", "always", "deny"]); // default full set
      }
    });

    test("external-binary reasonCode preserved end-to-end", () => {
      const ev = interruptValueToServerEvent(
        {
          type: "approval_ask",
          tools: [{ name: "run_shell", args: { command: "./install_boho.sh" } }],
          reason: "running an external script Nautilo did not create or install",
          reasonCode: "external-binary",
          allowedVerbs: ["once", "room", "always", "deny"],
        },
        "thread-4",
        "lane-4",
      );

      if (ev?.type === "approval.ask") {
        expect(ev.reasonCode).toBe("external-binary");
        expect(ev.reason).toContain("external script");
      }
    });

    test("network-egress-denied context is preserved and URL-free", () => {
      const ev = interruptValueToServerEvent(
        {
          type: "approval_ask",
          approvalId: "approval-net",
          tools: [{ name: "run_shell", args: { command: "curl https://api.weather.com/private?token=secret" } }],
          reason: "Agent attempted network access to api.weather.com:443",
          reasonCode: "network-egress-denied",
          network: {
            host: "api.weather.com",
            port: 443,
            reason: "no allow rule matched",
            suggestedRule: {
              type: "domain",
              host: "api.weather.com",
              ports: [443],
            },
          },
        },
        "thread-net",
        "lane-net",
      );

      if (ev?.type !== "approval.ask") throw new Error("expected approval.ask");
      expect(ev.approvalId).toBe("approval-net");
      expect(ev.reasonCode).toBe("network-egress-denied");
      expect(ev.network).toEqual({
        host: "api.weather.com",
        port: 443,
        reason: "no allow rule matched",
        suggestedRule: {
          type: "domain",
          host: "api.weather.com",
          ports: [443],
        },
      });
      expect(JSON.stringify(ev.network)).not.toContain("private");
      expect(JSON.stringify(ev.network)).not.toContain("secret");
    });

    test("all four verb values round-trip", () => {
      for (const verb of ["once", "room", "always", "deny"] as const) {
        const ev = interruptValueToServerEvent(
          {
            type: "approval_ask",
            tools: [],
            reason: "test",
            reasonCode: "destructive-tool",
            allowedVerbs: [verb],
          },
          "t",
          "l",
        );
        if (ev?.type === "approval.ask") {
          expect(ev.allowedVerbs).toEqual([verb]);
        }
      }
    });
  });
});
