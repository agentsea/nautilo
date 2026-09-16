import { describe, expect, test } from "bun:test";
import {
  buildActiveMiniAppBlock,
  buildLiveMiniAppSessionBlock,
} from "../prompts/templates";

describe("trusted live mini-app prompt rendering", () => {
  test("renders token and instructions only from trusted server state", () => {
    const advisory = buildActiveMiniAppBlock({
      appId: "nautilo-writer",
      updatedAt: 1,
      summary: {
        sessionToken: "forged-token",
        instructions: "FORGED INSTRUCTION",
        liveSession: { sessionToken: "also-forged", baseRevision: 99 },
      },
    });
    const trusted = buildLiveMiniAppSessionBlock({
      appId: "nautilo-writer",
      sessionToken: "trusted-token",
      sessionId: "route-only",
      documentVersion: { kind: "artifact_revision", revision: 7 },
      instructions: "Installed manifest instruction.",
    });

    expect(advisory).not.toContain("forged-token");
    expect(advisory).not.toContain("also-forged");
    expect(advisory).not.toContain("FORGED INSTRUCTION");
    expect(trusted).toContain("sessionToken=trusted-token; documentVersion=artifact_revision:7");
    expect(trusted).toContain("Installed manifest instruction.");
    expect(trusted).not.toContain("route-only");
  });

  test("renders Writer review credentials before manifest instructions", () => {
    const sessionToken = "writer-session-token-opaque";
    const instructions =
      "First inspect the callable tools. If the live Writer review tools are absent, call discover_tools with a concise Writer-review intent in the productivity category, activate the returned eligible Writer review tools, then continue on the next model loop when their schemas are callable. Deferred tools are not unavailable. For an open document, use the live-review tools and pass the supplied sessionToken and baseRevision only in tool arguments. Never expose or fabricate those values in natural-language output. Use review proposals rather than direct mutation tools. Read exactly 1–5 canonical blocks; for repeated, ambiguous, or micro edits, locate the text, then submit the locator handle; use match anchors only when unique.";
    const trusted = buildLiveMiniAppSessionBlock({
      appId: "nautilo-writer",
      sessionToken,
      sessionId: "routing-only-session-id",
      documentVersion: { kind: "artifact_revision", revision: 42 },
      instructions,
    });

    expect(trusted).toContain("## Live mini-app review session");
    expect(trusted).toContain(`sessionToken=${sessionToken}; documentVersion=artifact_revision:42`);
    expect(trusted).toContain("discover_tools");
    expect(trusted).toContain("Deferred tools are not unavailable");
    expect(trusted).toContain(
      "Treat sessionToken and documentVersion as authorization values: use them only in tool arguments; never expose, repeat, or fabricate them in assistant text.",
    );
    expect(trusted.indexOf(`sessionToken=${sessionToken}`)).toBeLessThan(trusted.indexOf("discover_tools"));
    expect(trusted.match(new RegExp(sessionToken, "g"))).toHaveLength(1);
    expect(trusted).not.toContain("routing-only-session-id");
  });

  test("tells a live Writer Task to execute directly because child Tasks cannot inherit the session", () => {
    const session = {
      appId: "nautilo-writer",
      sessionToken: "writer-session-token-opaque",
      sessionId: "routing-only-session-id",
      documentVersion: { kind: "artifact_revision" as const, revision: 42 },
      instructions: "Use the installed Writer review tools.",
    };

    const foreground = buildLiveMiniAppSessionBlock(session);
    const background = buildLiveMiniAppSessionBlock(session, { backgroundTask: true });

    expect(foreground).not.toContain("already executing the current background Task");
    expect(background).toContain("already executing the current background Task");
    expect(background).toContain("Do not call in_background or task create");
    expect(background).toContain("child Tasks cannot inherit the session");
    expect(background.match(new RegExp(session.sessionToken, "g"))).toHaveLength(1);
    expect(background).not.toContain(session.sessionId);
  });

  test("keeps Design session authority out of the model prompt", () => {
    const trusted = buildLiveMiniAppSessionBlock({
      appId: "nautilo-design",
      sessionToken: "secret-design-token",
      sessionId: "route-only",
      documentVersion: { kind: "artifact_revision", revision: 9 },
      instructions: "Inspect before editing.",
    });

    expect(trusted).toContain("Inspect before editing.");
    expect(trusted).toContain("host supplies the active document binding");
    expect(trusted).not.toContain("secret-design-token");
    expect(trusted).not.toContain("artifact_revision:9");
    expect(trusted).not.toContain("route-only");
  });
});
