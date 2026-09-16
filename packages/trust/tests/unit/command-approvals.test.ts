/**
 * M037 — command-approval classifier unit tests (pure; no DB).
 *
 * Covers the issue's step-4 matrix:
 *  - shell: head extraction (1/2/3-token verbs), path operand → parent dir,
 *    flags kept literal (rm vs rm -rf differ), arg operands generalized.
 *  - file: command literal + path → parent dir.
 *  - opaque tool: every slot exact, sameAsOnce = true.
 *  - signatureKey stable + canonical (order-independent for object args);
 *    round-trips through formatSignature.
 *  - determinism (#18): identical (toolName,args) → identical signatureKey.
 *  - money/amount: interim exact (#10).
 */

import { describe, test, expect } from "bun:test";
import {
  classifyCall,
  canonicalSignatureKey,
  formatSignature,
  tokenizeCommand,
} from "../../src/command-approvals";

describe("classifyCall — run_shell tokenizer", () => {
  test("single-token verb + path operand → parent directory", () => {
    const c = classifyCall("run_shell", { command: "ls /home/me/proj/src" });
    expect(c.generalizedDisplay).toBe("run_shell ls <directory:/home/me/proj>");
    expect(c.sameAsOnce).toBe(false);
  });

  test("two-token verb head (git push) → operands generalized to <arg>", () => {
    const c = classifyCall("run_shell", { command: "git push origin main" });
    expect(c.generalizedDisplay).toBe("run_shell git push <arg> <arg>");
  });

  test("three-token verb head (git remote add)", () => {
    const c = classifyCall("run_shell", { command: "git remote add origin git@x" });
    // "git remote add" is the literal head; the next operand generalizes.
    expect(c.generalizedDisplay.startsWith("run_shell git remote add ")).toBe(true);
    expect(c.generalizedDisplay).toContain("git remote add");
  });

  test("flags are kept literal — rm vs rm -rf differ", () => {
    const plain = classifyCall("run_shell", { command: "rm /tmp/x" });
    const force = classifyCall("run_shell", { command: "rm -rf /tmp/x" });
    expect(plain.signatureKey).not.toBe(force.signatureKey);
    expect(force.generalizedDisplay).toBe("run_shell rm -rf <directory:/tmp>");
  });

  test("sibling commands under same verb+dir share a signatureKey", () => {
    const a = classifyCall("run_shell", { command: "ls /a/b" });
    const b = classifyCall("run_shell", { command: "ls /a/c" });
    expect(a.signatureKey).toBe(b.signatureKey);
    const diffDir = classifyCall("run_shell", { command: "ls /x/y" });
    expect(a.signatureKey).not.toBe(diffDir.signatureKey);
  });

  test("quoted operands tokenize as one token", () => {
    expect(tokenizeCommand(`echo "hello world" foo`)).toEqual([
      "echo",
      "hello world",
      "foo",
    ]);
  });
});

describe("classifyCall — file tool", () => {
  test("command literal + path → parent dir", () => {
    const c = classifyCall("file", { command: "read", path: "/proj/a/notes.md" });
    expect(c.generalizedDisplay).toBe("file read <directory:/proj/a>");
    expect(c.sameAsOnce).toBe(false);
  });

  test("sibling paths under the same parent match; different parent does not", () => {
    const x = classifyCall("file", { command: "read", path: "/a/x.md" });
    const y = classifyCall("file", { command: "read", path: "/a/y.md" });
    const z = classifyCall("file", { command: "read", path: "/b/z.md" });
    expect(x.signatureKey).toBe(y.signatureKey);
    expect(x.signatureKey).not.toBe(z.signatureKey);
  });

  test("different command (read vs write) → different signature", () => {
    const read = classifyCall("file", { command: "read", path: "/a/x.md" });
    const write = classifyCall("file", { command: "write", path: "/a/x.md" });
    expect(read.signatureKey).not.toBe(write.signatureKey);
  });
});

describe("classifyCall — opaque / undeclared tools", () => {
  test("undeclared tool → every slot exact, sameAsOnce = true", () => {
    const c = classifyCall("some_new_tool", { foo: "bar", n: 3 });
    expect(c.sameAsOnce).toBe(true);
    expect(c.signature.slots.every((s) => s.kind === "exact")).toBe(true);
  });

  test("opaque sibling with a different arg does not match", () => {
    const a = classifyCall("some_new_tool", { foo: "bar" });
    const b = classifyCall("some_new_tool", { foo: "baz" });
    expect(a.signatureKey).not.toBe(b.signatureKey);
  });

  test("money/amount tool → exact-amount match (interim)", () => {
    const a = classifyCall("buy_thing", { amount: 10, item: "x" });
    const b = classifyCall("buy_thing", { amount: 20, item: "x" });
    expect(a.sameAsOnce).toBe(true);
    expect(a.signatureKey).not.toBe(b.signatureKey);
  });
});

describe("signatureKey — canonical + deterministic", () => {
  test("object-arg key order does not affect the signatureKey", () => {
    const a = classifyCall("some_new_tool", { a: 1, b: { y: 2, x: 1 } });
    const b = classifyCall("some_new_tool", { b: { x: 1, y: 2 }, a: 1 });
    expect(a.signatureKey).toBe(b.signatureKey);
  });

  test("determinism: same (toolName,args) → identical signatureKey across calls", () => {
    const args = { command: "ls /a/b/c" };
    const k1 = classifyCall("run_shell", args).signatureKey;
    const k2 = classifyCall("run_shell", { ...args }).signatureKey;
    expect(k1).toBe(k2);
  });

  test("canonicalSignatureKey(formatSignature) round-trip is stable", () => {
    const c = classifyCall("file", { command: "read", path: "/a/x.md" });
    expect(canonicalSignatureKey(c.signature)).toBe(c.signatureKey);
    expect(formatSignature(c.signature)).toBe(c.generalizedDisplay);
  });

  test("large exact values use a fixed-length indexed identity", () => {
    const patch = "*** Begin Patch\n" + "x".repeat(32_000);
    const first = classifyCall("apply_patch", { patch, target: "current" });
    const same = classifyCall("apply_patch", { target: "current", patch });
    const different = classifyCall("apply_patch", {
      patch: `${patch}y`,
      target: "current",
    });

    expect(first.signatureKey).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.signatureKey).toBe(same.signatureKey);
    expect(first.signatureKey).not.toBe(different.signatureKey);
    expect(Buffer.byteLength(first.signatureKey, "utf8")).toBeLessThan(128);
  });
});
