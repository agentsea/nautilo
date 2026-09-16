import { expect, test } from "bun:test";
import {
  getPasswordRecoveryDriver,
  passwordRecoveryUsesOssRelay,
} from "../../src/password-recovery-driver";

test("password recovery defaults to OSS relay in local mode", () => {
  expect(getPasswordRecoveryDriver({})).toBe("oss_relay");
  expect(passwordRecoveryUsesOssRelay({})).toBe(true);
});

test("password recovery defaults to Logto-native in cloud mode", () => {
  expect(getPasswordRecoveryDriver({ NAUTILO_HOSTING_MODE: "cloud" })).toBe(
    "logto_native",
  );
});

test("password recovery driver can be explicitly set", () => {
  expect(getPasswordRecoveryDriver({ NAUTILO_PASSWORD_RECOVERY_DRIVER: "disabled" })).toBe(
    "disabled",
  );
});

test("invalid password recovery driver throws", () => {
  expect(() =>
    getPasswordRecoveryDriver({ NAUTILO_PASSWORD_RECOVERY_DRIVER: "wat" }),
  ).toThrow();
});
