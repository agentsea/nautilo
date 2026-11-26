import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => JSON.parse(readFileSync(join(import.meta.dir, path), "utf8"));
const packages = ["libgssapi-krb5-2", "libk5crypto3", "libkrb5-3", "libkrb5support0"];
const source = read("server-vulnerability-exceptions.input.json");

test("server requires the supported Kerberos security update", () => {
  const floors = readFileSync(join(import.meta.dir, "server-security-package-floors.txt"), "utf8").split("\n");
  for (const name of packages) expect(floors).toContain(`${name} 1.21.3-5+deb13u2`);
});

test("retires every exception tied to superseded Kerberos binaries", () => {
  const before = read("fixtures/server-vulnerability-exceptions-2026-11-22-before-glibc.json");
  const retired = before.exceptions.filter((entry: { packageName: string }) => packages.includes(entry.packageName));
  expect(retired).toHaveLength(64);
  expect(new Set(retired.map((entry: { advisoryId: string }) => entry.advisoryId)).size).toBe(16);
  expect(source.exceptions.filter((entry: { packageName: string }) => packages.includes(entry.packageName))).toEqual([]);
});
