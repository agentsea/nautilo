/**
 * D403 (ISSUE-D403) Phase 1 — unit tests for the pure login-form scorer.
 *
 * These exercise `detectLoginForm` directly against plain field descriptors
 * (no DOM), covering the heuristic cases called out in the phase spec.
 *
 * Typing note: the desktop tsconfig's `types` is Node-only, and it `include`s
 * `electron/**` (so this colocated test *is* type-checked). Loading `bun-types`
 * — even just its `bun:test` slice — perturbs global lib types and breaks other
 * (non-owned) electron files (main.ts / kdbx-store.ts). `bun test` injects the
 * Jest-style API as runtime globals, so instead of importing `bun:test` we type
 * just the three we use with module-scoped `declare const`s. Being module-scoped
 * (this file has imports), they leak nothing into the main/node type world —
 * the same local-ambient posture P0 used for the DOM in the guest preload.
 */
import { detectLoginForm, type FieldDescriptor } from "./form-detect";

interface ExpectMatchers {
  toBe(expected: unknown): void;
  toBeUndefined(): void;
}
declare const describe: (label: string, fn: () => void) => void;
declare const test: (label: string, fn: () => void | Promise<void>) => void;
declare const expect: (actual: unknown) => ExpectMatchers;

/** Build a `FieldDescriptor` with sensible defaults for terse test fixtures. */
function field(overrides: Partial<FieldDescriptor> & { fieldId: string }): FieldDescriptor {
  return {
    tag: "input",
    type: "text",
    autocomplete: "",
    name: "",
    id: "",
    isVisible: true,
    ...overrides,
  };
}

describe("detectLoginForm (D403 P1)", () => {
  test("classic username + password form", () => {
    const result = detectLoginForm([
      field({ fieldId: "u", type: "text", name: "username" }),
      field({ fieldId: "p", type: "password", name: "password" }),
    ]);

    expect(result.isLoginForm).toBe(true);
    expect(result.passwordFieldId).toBe("p");
    expect(result.usernameFieldId).toBe("u");
  });

  test("email + password form", () => {
    const result = detectLoginForm([
      field({ fieldId: "e", type: "email", autocomplete: "email", name: "email" }),
      field({ fieldId: "p", type: "password", autocomplete: "current-password" }),
    ]);

    expect(result.isLoginForm).toBe(true);
    expect(result.passwordFieldId).toBe("p");
    expect(result.usernameFieldId).toBe("e");
  });

  test("password-only change-password page → still detects the password field", () => {
    const result = detectLoginForm([
      field({ fieldId: "old", type: "password", name: "current_password" }),
      field({ fieldId: "new", type: "password", name: "new_password" }),
      field({ fieldId: "confirm", type: "password", name: "confirm_password" }),
    ]);

    expect(result.isLoginForm).toBe(true);
    // First visible password field wins.
    expect(result.passwordFieldId).toBe("old");
    expect(result.usernameFieldId).toBeUndefined();
  });

  test("no-login page (no password field) → not a login form", () => {
    const result = detectLoginForm([
      field({ fieldId: "q", type: "search", name: "query" }),
      field({ fieldId: "n", type: "text", name: "full_name" }),
    ]);

    expect(result.isLoginForm).toBe(false);
    expect(result.passwordFieldId).toBeUndefined();
    expect(result.usernameFieldId).toBeUndefined();
  });

  test("multiple candidates → picks the text field adjacent to the password", () => {
    const result = detectLoginForm([
      // A far-away plain text field (e.g. a search box) with no useful hints.
      field({ fieldId: "search", type: "text", name: "" }),
      field({ fieldId: "unrelated", type: "text", name: "" }),
      // The field immediately preceding the password is the identifier.
      field({ fieldId: "login", type: "text", name: "" }),
      field({ fieldId: "p", type: "password" }),
    ]);

    expect(result.isLoginForm).toBe(true);
    expect(result.passwordFieldId).toBe("p");
    expect(result.usernameFieldId).toBe("login");
  });

  test("strong attribute match beats mere adjacency", () => {
    const result = detectLoginForm([
      // Named identifier field, but not adjacent to the password.
      field({ fieldId: "user", type: "text", name: "username" }),
      // Adjacent plain text field with no hints (should lose to the named one).
      field({ fieldId: "coupon", type: "text", name: "coupon_code" }),
      field({ fieldId: "p", type: "password" }),
    ]);

    expect(result.usernameFieldId).toBe("user");
  });

  test("hidden password field is not treated as a login form", () => {
    const result = detectLoginForm([
      field({ fieldId: "u", type: "text", name: "username" }),
      field({ fieldId: "p", type: "password", isVisible: false }),
    ]);

    expect(result.isLoginForm).toBe(false);
    expect(result.passwordFieldId).toBeUndefined();
  });
});
