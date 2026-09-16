import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const auditedXmldomVersion = "0.9.12";
const auditedKdbxwebVersion = "2.1.1";
const compatiblePlistVersion = "3.1.1";
const require = createRequire(import.meta.url);

function resolvedVersions(lockfile: string, packageName: string): string[] {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...lockfile.matchAll(
      new RegExp(`(?:^|["\\s])${escapedName}@(\\d+\\.\\d+\\.\\d+)`, "g"),
    ),
  ].map((match) => match[1]!);
}

describe("xmldom security floor", () => {
  test("pins kdbxweb, plist, and every xmldom resolution to compatible audited releases", async () => {
    const manifest = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, unknown>;
      overrides?: Record<string, unknown>;
      patchedDependencies?: Record<string, unknown>;
    };
    expect(manifest.dependencies?.["kdbxweb"]).toBe(auditedKdbxwebVersion);
    expect(manifest.dependencies?.["@xmldom/xmldom"]).toBe(
      auditedXmldomVersion,
    );
    expect(manifest.overrides?.["@xmldom/xmldom"]).toBe(
      auditedXmldomVersion,
    );
    expect(manifest.overrides?.["plist"]).toBe(compatiblePlistVersion);
    expect(manifest.patchedDependencies?.["plist@3.1.0"]).toBeUndefined();
    expect(manifest.patchedDependencies?.["@expo/plist@0.8.1"]).toBe(
      "patches/@expo%2Fplist@0.8.1.patch",
    );

    const lockfile = await readFile(join(repositoryRoot, "bun.lock"), "utf8");
    expect(new Set(resolvedVersions(lockfile, "@xmldom/xmldom"))).toEqual(
      new Set([auditedXmldomVersion]),
    );
    expect(new Set(resolvedVersions(lockfile, "plist"))).toEqual(
      new Set([compatiblePlistVersion]),
    );
  });

  test("keeps Electron Builder's CommonJS plist parser compatible with xmldom", () => {
    const plist = require("plist") as {
      parse: (xml: string) => Record<string, unknown>;
    };

    expect(
      plist.parse(
        '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.nautilo.desktop</string></dict></plist>',
      ),
    ).toEqual({ CFBundleIdentifier: "com.nautilo.desktop" });
  });

  test("keeps Expo's plist parser compatible with its xmldom API", () => {
    const expoPlist = require("@expo/plist") as {
      default: { parse: (xml: string) => Record<string, unknown> };
    };

    expect(
      expoPlist.default.parse(
        '\n<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.nautilo.app</string></dict></plist>',
      ),
    ).toEqual({ CFBundleIdentifier: "ai.nautilo.app" });
  });
});
