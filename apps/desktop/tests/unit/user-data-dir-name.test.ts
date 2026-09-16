/**
 * Stack 19 Phase 4 (D156 Architecture amendment) — pin the 4-way matrix
 * for `computeUserDataDirName({...})` so a future regression to the
 * pre-Stack-19 profile-only shape is mechanically caught.
 *
 * Load-bearing assertion: `(default, default) → "Nautilo"` MUST hold
 * because that's what preserves existing operator state across the
 * Stack 19 cutover. If this assertion ever fails, real default-instance
 * Electron state is orphaned (Local Storage / IndexedDB /
 * current-folder pointer) on the next post-merge launch.
 */
import { describe, expect, test } from "bun:test";
import { computeUserDataDirName } from "../../electron/user-data-dir-name";

const APP = "Nautilo";

describe("computeUserDataDirName — 4-way (instance × profile) matrix", () => {
  test("default instance + default profile → bare APP_NAME (preserves pre-Stack-19 operator state)", () => {
    expect(
      computeUserDataDirName({
        appName: APP,
        instanceId: "",
        isDefaultInstance: true,
        profile: undefined,
      }),
    ).toBe("Nautilo"); // LOAD-BEARING — must not regress.
  });

  test("named instance + default profile → APP_NAME-<instance>", () => {
    expect(
      computeUserDataDirName({
        appName: APP,
        instanceId: "smoke-stack19",
        isDefaultInstance: false,
        profile: undefined,
      }),
    ).toBe("Nautilo-smoke-stack19");
  });

  test("default instance + named profile → APP_NAME-<profile> (preserves M097 profile-only convention)", () => {
    expect(
      computeUserDataDirName({
        appName: APP,
        instanceId: "",
        isDefaultInstance: true,
        profile: "galina",
      }),
    ).toBe("Nautilo-galina");
  });

  test("named instance + named profile → APP_NAME-<instance>-<profile>", () => {
    expect(
      computeUserDataDirName({
        appName: APP,
        instanceId: "smoke-stack19",
        isDefaultInstance: false,
        profile: "galina",
      }),
    ).toBe("Nautilo-smoke-stack19-galina");
  });
});

describe("computeUserDataDirName — edge cases", () => {
  test("empty-string profile coerces to no-profile (defensive against malformed --profile '')", () => {
    expect(
      computeUserDataDirName({
        appName: APP,
        instanceId: "smoke-stack19",
        isDefaultInstance: false,
        profile: "",
      }),
    ).toBe("Nautilo-smoke-stack19");
  });

  test("isDefaultInstance: true overrides non-empty instanceId (defensive — never trust caller's id field when boolean says default)", () => {
    expect(
      computeUserDataDirName({
        appName: APP,
        instanceId: "stale-non-empty-string",
        isDefaultInstance: true,
        profile: undefined,
      }),
    ).toBe("Nautilo");
  });

  test("isDefaultInstance: false AND empty instanceId still collapses to default (defensive — both signals must agree)", () => {
    // If a caller passes isDefaultInstance: false but instanceId is "",
    // we cannot generate a "-${empty}" suffix; collapse to default rather
    // than yield a malformed "Nautilo-" trailing-dash basename.
    expect(
      computeUserDataDirName({
        appName: APP,
        instanceId: "",
        isDefaultInstance: false,
        profile: undefined,
      }),
    ).toBe("Nautilo");
  });

  test("custom appName threads through unchanged", () => {
    expect(
      computeUserDataDirName({
        appName: "MyTestApp",
        instanceId: "foo",
        isDefaultInstance: false,
        profile: "bar",
      }),
    ).toBe("MyTestApp-foo-bar");
  });

  test("vacuous-test guard: replacing impl with `() => 'Nautilo'` would fail the named-instance case", () => {
    // This is the same guard used in Phase 1 / Phase 2.3 R1 tests — the
    // load-bearing assertion is "named instance produces a different basename
    // from default instance". Without that, the helper would silently
    // collapse all instances to one userData dir (the pre-Stack-19 bug).
    const nameDefault = computeUserDataDirName({
      appName: APP,
      instanceId: "",
      isDefaultInstance: true,
      profile: undefined,
    });
    const nameNamed = computeUserDataDirName({
      appName: APP,
      instanceId: "foo",
      isDefaultInstance: false,
      profile: undefined,
    });
    expect(nameDefault).not.toBe(nameNamed);
  });
});
