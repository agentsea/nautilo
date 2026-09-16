import { describe, expect, test } from "bun:test";

import {
  OOXML_FORMATS,
  assertProductionOoxmlAssetClosure,
} from "../../../scripts/ooxml-delivery-probe";

describe("D431 production OOXML asset closure probe", () => {
  test("keeps the expected three direct parser asset identities", () => {
    expect(OOXML_FORMATS).toEqual(["docx", "xlsx", "pptx"]);
  });

  test("fails closed unless each production parser asset is version-matched WASM", () => {
    const passing = {
      distDir: "/fixture/dist",
      packageVersion: "0.75.0",
      totalDistBytes: 1,
      allWasmAssetNames: ["docx_parser_bg-a.wasm", "xlsx_parser_bg-b.wasm", "pptx_parser_bg-c.wasm"],
      parserAssets: OOXML_FORMATS.map((format) => ({
        format,
        name: `${format}_parser_bg-test.wasm`,
        byteLength: 1,
        sha256: "fixture",
        wasmMagic: true,
        matchesInstalledPackage: true,
      })),
    } as const;
    expect(() => assertProductionOoxmlAssetClosure(passing)).not.toThrow();
    expect(() => assertProductionOoxmlAssetClosure({ ...passing, parserAssets: passing.parserAssets.slice(1) })).toThrow();
    expect(() => assertProductionOoxmlAssetClosure({ ...passing, packageVersion: "0.75.99" })).not.toThrow();
    expect(() => assertProductionOoxmlAssetClosure({ ...passing, packageVersion: "0.76.0" })).toThrow();
    expect(() => assertProductionOoxmlAssetClosure({
      ...passing,
      parserAssets: passing.parserAssets.map((asset, index) => index === 0 ? { ...asset, matchesInstalledPackage: false } : asset),
    })).toThrow();
  });
});
