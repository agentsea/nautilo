import { describe, expect, test } from "bun:test";
import { createFile, type AgentToolContext } from "./agent-tool-handlers";
import { parseWriterHtml } from "./office-document";

function host(create: AgentToolContext["nautiloApp"]["document"]["createDocument"]): AgentToolContext {
  return {
    nautiloApp: {
      document: {
        createDocument: create,
        read: async () => { throw new Error("Creation must not read or overwrite another document"); },
        write: async () => { throw new Error("Creation must use create-only storage"); },
      },
      office: { run: async () => { throw new Error("Native Writer needs no OfficeCLI binary"); } },
    },
  };
}

describe("Genie Writer creation", () => {
  test("creates valid native bytes and an editable Workspace target", async () => {
    const result = await createFile({ filename: "Migration check" }, host(async args => {
      expect(args.surface).toBe("workspace");
      expect(args.path).toBe("Migration check.doc.html");
      expect(args.overwrite).toBe(false);
      const parsed = parseWriterHtml(args.content);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.document.document.blocks).toBeArray();
      return { ok: true, artifactPath: args.path, sha256: "saved-sha", byteLength: args.content.length };
    }));
    expect(result).toMatchObject({ ok: true, status: "created", opened: false, displayPath: "Migration check.doc.html",
      target: { surface: "workspace", path: "Migration check.doc.html" } });
  });

  test("refuses invalid names and invented authority before writing", async () => {
    const ctx = host(async () => { throw new Error("must not write"); });
    for (const args of [null, [], {}, { filename: "../existing" }, { filename: "/existing" },
      { filename: "a\\b" }, { filename: ".doc.html" }, { filename: "a", roomId: "forged" },
      { filename: "a", overwrite: true }, { filename: "a", targetSurface: "remote" }, { filename: "a", targetSurface: "currentFolder" }]) {
      expect(await createFile(args, ctx)).toMatchObject({ status: "invalid_request", stateChanged: false });
    }
  });

  test("preserves name collisions without an overwrite or a success claim", async () => {
    expect(await createFile({ filename: "Existing.doc.html" }, host(async args => {
      expect(args.path).toBe("Existing.doc.html");
      expect(args.overwrite).toBe(false);
      return { ok: false, code: "EXISTS", message: "Choose a different name." };
    }))).toMatchObject({ ok: false, status: "create_failed", code: "EXISTS", stateChanged: false, retrySafe: false });
  });

  test("retains a host receipt when bytes changed but metadata is uncertain", async () => {
    expect(await createFile({ filename: "Partial" }, host(async () => ({
      ok: false, code: "METADATA_UNCONFIRMED", message: "Bytes saved; inspect before retrying.",
      stateChanged: true, retrySafe: false,
    })))).toMatchObject({ ok: false, stateChanged: true, retrySafe: false, phase: "persist" });
  });

  test("a lost receipt reports uncertain state and prevents blind retry", async () => {
    expect(await createFile({ filename: "Interrupted" }, host(async () => {
      throw new Error("Relay disconnected after dispatch");
    }))).toMatchObject({ ok: false, code: "create_uncertain", stateChanged: "unknown", retrySafe: false });
  });
});
