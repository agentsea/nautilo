import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeFederatedId,
  parseFederatedId,
  normalizeHandle,
  validateHandle,
  slugifyToHandle,
  getServerHostname,
} from "../../src/federated-id";
import { __resetResolvedInstanceForTests } from "../../src/resolve-instance";

describe("composeFederatedId", () => {
  test("builds @handle@server literally", () => {
    expect(composeFederatedId("alex", "nautilo.local")).toBe("@alex@nautilo.local");
  });

  test("does not normalize or validate inputs", () => {
    // Pure string op; callers validate upstream.
    expect(composeFederatedId("Weird_Handle", "NAUTILO.LOCAL")).toBe(
      "@Weird_Handle@NAUTILO.LOCAL",
    );
  });
});

describe("parseFederatedId", () => {
  test("parses @alex@nautilo.local", () => {
    expect(parseFederatedId("@alex@nautilo.local")).toEqual({
      handle: "alex",
      server: "nautilo.local",
    });
  });

  test("parses @a1@example.com", () => {
    // Note: handle `a1` is 2 chars — parse accepts it, validate would reject.
    // parseFederatedId is a format parser, not a validator.
    expect(parseFederatedId("@a1@example.com")).toEqual({
      handle: "a1",
      server: "example.com",
    });
  });

  test("rejects missing leading @", () => {
    expect(parseFederatedId("alex@nautilo.local")).toBeNull();
  });

  test("rejects server without a dot", () => {
    // @a@b is structurally plausible but the server `b` has no dot;
    // we reject to avoid ambiguity with malformed input.
    expect(parseFederatedId("@a@b")).toBeNull();
  });

  test("rejects uppercase handle", () => {
    expect(parseFederatedId("@Alex@nautilo.local")).toBeNull();
  });

  test("rejects empty string", () => {
    expect(parseFederatedId("")).toBeNull();
  });
});

describe("normalizeHandle", () => {
  test("trims whitespace and lowercases", () => {
    expect(normalizeHandle("  Alex  ")).toBe("alex");
  });

  test("preserves already-normalized input", () => {
    expect(normalizeHandle("alex")).toBe("alex");
  });

  test("does not strip invalid characters", () => {
    // normalizeHandle only handles case/whitespace; validateHandle
    // rejects invalid characters downstream with a friendly reason.
    expect(normalizeHandle("  Alex!  ")).toBe("alex!");
  });
});

describe("validateHandle", () => {
  test("accepts a normal handle", () => {
    expect(validateHandle("alex")).toEqual({ ok: true });
  });

  test("accepts handles with - and _ in the middle", () => {
    expect(validateHandle("alex-smith")).toEqual({ ok: true });
    expect(validateHandle("alex_smith")).toEqual({ ok: true });
    expect(validateHandle("a1b2c3")).toEqual({ ok: true });
  });

  test("rejects too-short input", () => {
    const result = validateHandle("al");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("at least 3");
  });

  test("rejects too-long input", () => {
    const result = validateHandle("a".repeat(33));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("32 characters or fewer");
  });

  test("rejects uppercase", () => {
    const result = validateHandle("Alex");
    expect(result.ok).toBe(false);
  });

  test("rejects leading separator", () => {
    expect(validateHandle("-alex").ok).toBe(false);
    expect(validateHandle("_alex").ok).toBe(false);
  });

  test("rejects trailing separator", () => {
    expect(validateHandle("alex-").ok).toBe(false);
    expect(validateHandle("alex_").ok).toBe(false);
  });

  test("rejects invalid characters", () => {
    expect(validateHandle("alex!").ok).toBe(false);
    expect(validateHandle("alex.smith").ok).toBe(false);
    expect(validateHandle("alex@nautilo").ok).toBe(false);
  });
});

describe("slugifyToHandle", () => {
  test("lowercases", () => {
    expect(slugifyToHandle("Alex")).toBe("alex");
  });

  test("replaces spaces with hyphens", () => {
    expect(slugifyToHandle("Alex Smith")).toBe("alex-smith");
  });

  test("strips diacritics (ASCII-transliterates)", () => {
    expect(slugifyToHandle("Álex")).toBe("alex");
    expect(slugifyToHandle("Mariä")).toBe("maria");
  });

  test("collapses runs of separators", () => {
    expect(slugifyToHandle("Alex  Smith")).toBe("alex-smith");
    expect(slugifyToHandle("Alex---Smith")).toBe("alex-smith");
  });

  test("strips leading/trailing separators", () => {
    expect(slugifyToHandle("--alex--")).toBe("alex");
  });

  test("returns null for pure-symbol input", () => {
    expect(slugifyToHandle("!!!")).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(slugifyToHandle("")).toBeNull();
  });

  test("returns null when result is too short", () => {
    expect(slugifyToHandle("a")).toBeNull();
    expect(slugifyToHandle("ab")).toBeNull();
  });

  test("clamps very long input to 32 chars", () => {
    const long = "a".repeat(64);
    const result = slugifyToHandle(long);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(32);
  });

  test("slugifies the seed-placeholder 'user' cleanly", () => {
    // Matches the seedDefaultOwner auto-derive path: the placeholder
    // name "user" (from seedDefaultOwner's original default) slugifies
    // to "user", which is a valid 4-char handle.
    expect(slugifyToHandle("user")).toBe("user");
  });
});

describe("getServerHostname", () => {
  let userHomeDir: string;

  beforeEach(() => {
    __resetResolvedInstanceForTests();
    userHomeDir = mkdtempSync(join(tmpdir(), "nautilo-fed-"));
  });

  afterEach(() => {
    __resetResolvedInstanceForTests();
    rmSync(userHomeDir, { recursive: true, force: true });
  });

  test("defaults to nautilo.local from resolveInstance", () => {
    const env = { HOME: userHomeDir, NAUTILO_INSTANCE_ID: "" } as NodeJS.ProcessEnv;
    expect(getServerHostname(env, { userHomeDir })).toBe("nautilo.local");
  });

  test("NAUTILO_HOSTNAME env override", () => {
    const env = {
      HOME: userHomeDir,
      NAUTILO_INSTANCE_ID: "",
      NAUTILO_HOSTNAME: "nautilo.example.com",
    } as NodeJS.ProcessEnv;
    expect(getServerHostname(env, { userHomeDir })).toBe("nautilo.example.com");
  });

  test("NAUTILO_FEDERATED_HOSTNAME wins over NAUTILO_HOSTNAME", () => {
    const env = {
      HOME: userHomeDir,
      NAUTILO_INSTANCE_ID: "",
      NAUTILO_FEDERATED_HOSTNAME: "fed.example",
      NAUTILO_HOSTNAME: "host.example",
    } as NodeJS.ProcessEnv;
    expect(getServerHostname(env, { userHomeDir })).toBe("fed.example");
  });
});
