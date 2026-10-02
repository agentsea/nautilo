import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { MANAGED_PROVIDER_CREDENTIAL_ROUTE_DECISIONS } from "../../src/managed-provider-route-inventory";

describe("managed provider credential route inventory", () => {
  test("requires an explicit cloud-managed decision for every credential-shaped route", async () => {
    const routesRoot = resolve(import.meta.dir, "../../src/routes");
    const paths = new Set<string>();
    for (const name of await readdir(routesRoot)) {
      if (!name.endsWith(".ts")) continue;
      const source = await readFile(join(routesRoot, name), "utf8");
      for (const match of source.matchAll(/["'](\/api\/[^"']*(?:keys|credentials?)[^"']*)["']/g)) {
        if (match[1]) paths.add(match[1]);
      }
      for (const match of source.matchAll(/["'](\/api\/setup\/research-provider)["']/g)) {
        if (match[1]) paths.add(match[1]);
      }
    }
    expect([...paths].sort()).toEqual(Object.keys(MANAGED_PROVIDER_CREDENTIAL_ROUTE_DECISIONS).sort());
  });
});
