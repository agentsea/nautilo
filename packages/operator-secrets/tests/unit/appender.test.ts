import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendOperatorSecrets } from "../../src/appender.ts";
import { parseOperatorSecretsBody } from "../../src/loader.ts";

describe("appendOperatorSecrets (§13.3)", () => {
  test.skipIf(process.platform === "win32")("creates file mode 0600 with header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nautilo-append-"));
    const p = join(dir, "secrets.env");
    await appendOperatorSecrets({
      path: p,
      entries: [{ key: "OPENAI_API_KEY", value: "sk-test-append" }],
      createIfMissing: true,
    });
    const body = readFileSync(p, "utf8");
    expect(body).toContain("OPENAI_API_KEY");
    const m = parseOperatorSecretsBody(body);
    expect(m["OPENAI_API_KEY"]).toBe("sk-test-append");
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test.skipIf(process.platform === "win32")("idempotent replace same key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nautilo-append-"));
    const p = join(dir, "secrets.env");
    await appendOperatorSecrets({
      path: p,
      entries: [{ key: "OPENAI_API_KEY", value: "first" }],
      createIfMissing: true,
    });
    await appendOperatorSecrets({
      path: p,
      entries: [{ key: "OPENAI_API_KEY", value: "second" }],
      createIfMissing: true,
    });
    const raw = readFileSync(p, "utf8");
    expect((raw.match(/OPENAI_API_KEY=/g) ?? []).length).toBe(1);
    const m = parseOperatorSecretsBody(raw);
    expect(m["OPENAI_API_KEY"]).toBe("second");
  });

  test.skipIf(process.platform === "win32")(
    "repeated appends with same comment do not accumulate duplicate comment lines",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "nautilo-append-"));
      const p = join(dir, "secrets.env");
      const entry = {
        key: "NAUTILO_BOOTSTRAP_ADMIN_PASSWORD_D112_SMOKE",
        value: "pw",
        comment: "bootstrap admin password for instance d112-smoke",
      };
      for (let i = 0; i < 5; i++) {
        await appendOperatorSecrets({
          path: p,
          entries: [{ ...entry, value: `pw${i}` }],
          createIfMissing: true,
        });
      }
      const body = readFileSync(p, "utf8");
      const commentLine = `# ${entry.comment}`;
      const occurrences = body
        .split(/\r?\n/)
        .filter((l) => l === commentLine).length;
      expect(occurrences).toBe(1);
      expect((body.match(/NAUTILO_BOOTSTRAP_ADMIN_PASSWORD_D112_SMOKE=/g) ?? []).length).toBe(1);
    },
  );

  test.skipIf(process.platform === "win32")(
    "self-heals pre-existing duplicate-comment bloat on next write",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "nautilo-append-"));
      const p = join(dir, "secrets.env");
      const bloated = [
        "# bootstrap PIN for instance d112-smoke",
        "# bootstrap PIN for instance d112-smoke",
        "# bootstrap PIN for instance d112-smoke",
        "# bootstrap PIN for instance d112-smoke",
        "NAUTILO_BOOTSTRAP_PIN_D112_SMOKE=000000",
        "",
      ].join("\n");
      writeFileSync(p, bloated, { mode: 0o600 });
      chmodSync(p, 0o600);
      await appendOperatorSecrets({
        path: p,
        entries: [
          {
            key: "NAUTILO_BOOTSTRAP_PIN_D112_SMOKE",
            value: "111111",
            comment: "bootstrap PIN for instance d112-smoke",
          },
        ],
        createIfMissing: true,
      });
      const body = readFileSync(p, "utf8");
      expect(
        body.split(/\r?\n/).filter((l) => l === "# bootstrap PIN for instance d112-smoke").length,
      ).toBe(1);
      const m = parseOperatorSecretsBody(body);
      expect(m["NAUTILO_BOOTSTRAP_PIN_D112_SMOKE"]).toBe("111111");
    },
  );

  test.skipIf(process.platform === "win32")("refuses append when existing file is 0644", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nautilo-append-"));
    const p = join(dir, "secrets.env");
    writeFileSync(p, "OPENAI_API_KEY=old\n", { mode: 0o644 });
    chmodSync(p, 0o644);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is thenable; the rule's type inference doesn't see through it.
    await expect(
      appendOperatorSecrets({
        path: p,
        entries: [{ key: "ANTHROPIC_API_KEY", value: "x" }],
        createIfMissing: true,
      }),
    ).rejects.toThrow(/mode 0600/);
  });
});
