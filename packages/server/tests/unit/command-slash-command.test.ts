import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as commandsDb from "@nautilo/db";
import {
  formatCommandSlashUserMessage,
  scanCommandTokens,
  resolveCommandSlashCommandContent,
} from "../../src/messaging/command-slash-command";

const USER_A = "00000000-0000-0000-0000-000000000001";
const AGENT_A = "00000000-0000-0000-0000-0000000000a1";

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

/** Mock the DB by-name lookup that resolveCommandByName delegates to. */
function mockGetCommandByName(
  bodies: Record<string, string>,
  opts?: { enabled?: boolean },
) {
  const enabled = opts?.enabled ?? true;
  const sp = spyOn(commandsDb, "getCommandByName").mockImplementation(
    async (agentId, userId, name) => {
      const body = bodies[name];
      if (agentId === AGENT_A && userId === USER_A && body !== undefined) {
        return {
          id: `cmd-${name}`,
          agentId: AGENT_A,
          userId: USER_A,
          name,
          description: name,
          body,
          enabled,
          source: "user",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        };
      }
      return null;
    },
  );
  restores.push(() => sp.mockRestore());
}

describe("scanCommandTokens (word-boundary /name)", () => {
  test("finds a leading command", () => {
    expect(scanCommandTokens("/summarize").map((t) => t.name)).toEqual(["summarize"]);
  });

  test("finds a command after whitespace (mid-message)", () => {
    expect(scanCommandTokens("hey /summarize now").map((t) => t.name)).toEqual([
      "summarize",
    ]);
  });

  test("finds multiple commands in order", () => {
    expect(scanCommandTokens("/a then /b-c and /d").map((t) => t.name)).toEqual([
      "a",
      "b-c",
      "d",
    ]);
  });

  test("does NOT match a mid-word slash (paths, and/or)", () => {
    expect(scanCommandTokens("src/foo.ts")).toEqual([]);
    expect(scanCommandTokens("this and/or that")).toEqual([]);
    expect(scanCommandTokens("a/b/c")).toEqual([]);
  });

  test("ignores a bare slash and a slash with no valid leading name char", () => {
    expect(scanCommandTokens("/ ")).toEqual([]);
    expect(scanCommandTokens("say /_private stuff")).toEqual([]);
  });

  test("matches the valid [a-z0-9-] prefix and stops at _ or . (like a period)", () => {
    // Only expands later if the prefix actually resolves to a command.
    expect(scanCommandTokens("/snake_case").map((t) => t.name)).toEqual(["snake"]);
    expect(scanCommandTokens("/dot.name").map((t) => t.name)).toEqual(["dot"]);
  });
});

describe("formatCommandSlashUserMessage", () => {
  test("substitutes all $ARGUMENTS occurrences", () => {
    expect(
      formatCommandSlashUserMessage(
        { name: "echo", body: "Say: $ARGUMENTS\nAgain: $ARGUMENTS" },
        "hi",
      ),
    ).toBe("Say: hi\nAgain: hi");
  });

  test("appends trailing text when body has no $ARGUMENTS", () => {
    expect(
      formatCommandSlashUserMessage(
        { name: "summarize", body: "Summarize the conversation." },
        "focus on action items",
      ),
    ).toBe("Summarize the conversation.\n\nfocus on action items");
  });

  test("leaves body unchanged with no $ARGUMENTS and no trailing text", () => {
    expect(
      formatCommandSlashUserMessage(
        { name: "summarize", body: "Summarize the conversation." },
        "",
      ),
    ).toBe("Summarize the conversation.");
  });

  test("replaces $ARGUMENTS with empty string when no trailing text", () => {
    expect(
      formatCommandSlashUserMessage({ name: "echo", body: "Say: $ARGUMENTS" }, ""),
    ).toBe("Say:");
  });
});

describe("resolveCommandSlashCommandContent — inline, multi-command", () => {
  test("single leading command consumes trailing text as $ARGUMENTS", async () => {
    mockGetCommandByName({ teach: "Drill the user on $ARGUMENTS." });
    const out = await resolveCommandSlashCommandContent(
      "/teach french verbs",
      AGENT_A,
      USER_A,
    );
    expect(out.handled).toBe(true);
    expect(out.content).toBe("Drill the user on french verbs.");
  });

  test("command mid-sentence expands in place; leading prose preserved", async () => {
    mockGetCommandByName({ translate: "Translate the above into $ARGUMENTS." });
    const out = await resolveCommandSlashCommandContent(
      "write a poem then /translate to French",
      AGENT_A,
      USER_A,
    );
    expect(out.handled).toBe(true);
    expect(out.content).toBe(
      "write a poem then Translate the above into to French.",
    );
  });

  test("multiple no-arg commands expand as pure macros, whitespace preserved", async () => {
    mockGetCommandByName({
      summarize: "Summarize this thread.",
      "release-notes": "Draft release notes.",
    });
    const out = await resolveCommandSlashCommandContent(
      "/summarize /release-notes",
      AGENT_A,
      USER_A,
    );
    expect(out.handled).toBe(true);
    expect(out.content).toBe("Summarize this thread. Draft release notes.");
  });

  test("argument span stops at the next command token", async () => {
    mockGetCommandByName({
      teach: "Drill on $ARGUMENTS.",
    });
    // Second /teach also resolves; first's $ARGUMENTS must stop before it.
    const out = await resolveCommandSlashCommandContent(
      "/teach french /teach spanish",
      AGENT_A,
      USER_A,
    );
    expect(out.handled).toBe(true);
    expect(out.content).toBe("Drill on french.\n\nDrill on spanish.");
  });

  test("leading command takes the whole remainder (incl. newlines) as $ARGUMENTS", async () => {
    mockGetCommandByName({ tone: "Rewrite: [$ARGUMENTS]" });
    const out = await resolveCommandSlashCommandContent(
      "/tone make this\nless rude\nand fix grammar",
      AGENT_A,
      USER_A,
    );
    expect(out.handled).toBe(true);
    expect(out.content).toBe("Rewrite: [make this\nless rude\nand fix grammar]");
  });

  test("a mid-sentence command's $ARGUMENTS still stops at the newline", async () => {
    mockGetCommandByName({ tone: "Rewrite: [$ARGUMENTS]" });
    const out = await resolveCommandSlashCommandContent(
      "please /tone this line\nbut not this line",
      AGENT_A,
      USER_A,
    );
    expect(out.handled).toBe(true);
    expect(out.content).toBe("please Rewrite: [this line]\nbut not this line");
  });

  test("known + unknown mix: unknown left literal, known expands", async () => {
    mockGetCommandByName({ summarize: "Summarize this." });
    const out = await resolveCommandSlashCommandContent(
      "/summarize and /bogus stays",
      AGENT_A,
      USER_A,
    );
    expect(out.handled).toBe(true);
    expect(out.content).toBe("Summarize this. and /bogus stays");
  });

  test("unknown-only /name passes through unchanged", async () => {
    mockGetCommandByName({});
    const out = await resolveCommandSlashCommandContent(
      "/does-not-exist maybe args",
      AGENT_A,
      USER_A,
    );
    expect(out.handled).toBe(false);
    expect(out.content).toBe("/does-not-exist maybe args");
  });

  test("disabled DB command passes through unchanged (no body leak)", async () => {
    mockGetCommandByName({ "off-mode": "secret body" }, { enabled: false });
    const out = await resolveCommandSlashCommandContent("/off-mode", AGENT_A, USER_A);
    expect(out.handled).toBe(false);
    expect(out.content).toBe("/off-mode");
    expect(out.content).not.toContain("secret body");
  });

  test("guest speaker: command does not expand", async () => {
    mockGetCommandByName({ summarize: "Summarize this." });
    const out = await resolveCommandSlashCommandContent("/summarize", AGENT_A, USER_A, {
      isGuest: true,
    });
    expect(out.handled).toBe(false);
    expect(out.content).toBe("/summarize");
  });

  test("non-slash message passes through unchanged", async () => {
    const out = await resolveCommandSlashCommandContent(
      "tutor me in French",
      AGENT_A,
      USER_A,
    );
    expect(out.handled).toBe(false);
    expect(out.content).toBe("tutor me in French");
  });

  test("mid-word slash (path) is not treated as a command", async () => {
    mockGetCommandByName({ foo: "SHOULD NOT APPEAR" });
    const out = await resolveCommandSlashCommandContent(
      "edit src/foo.ts please",
      AGENT_A,
      USER_A,
    );
    expect(out.handled).toBe(false);
    expect(out.content).toBe("edit src/foo.ts please");
  });
});
