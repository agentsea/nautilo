// @nautilo/config/officecli — pure OfficeCLI core (node-only subpath).
//
// Relocated from packages/server/src/{officecli.ts,office-create.ts} in D396
// Wave 2a so both @nautilo/agent and @nautilo/server can import it without
// the server→agent dependency edge flipping. Mirrors the existing
// `@nautilo/config/vendored-binary` node-only subpath convention — DO NOT add
// this to the config barrel (`src/index.ts`); it pulls in node:child_process
// and node:fs which must never leak into a browser bundle.
//
// Public surface:
//   - run.ts:     path/env helpers, runOfficeCliRaw, version probe, plus the
//                 P4 `buildVersionArgv` / `buildDumpArgv` / `buildGetArgv`
//                 (savePath/outPath spellings, default "/" path).
//   - generate.ts: full Wave-1+2a argv surface (create/batch/view/get/query/
//                 set/add/remove/move/swap/validate/dump/merge/raw/raw-set/
//                 add-part/close/open/save/refresh/help), generateOffice,
//                 renderOffice, OfficeCreateError, types.
//
// NAME-CLASH POLICY: run.ts and generate.ts both export `buildGetArgv` and
// `buildDumpArgv` with DIFFERENT signatures (P4 groundwork vs Wave 1 full
// surface). `export *` from both would silently drop both names per the ES
// module spec, so we explicitly re-export each under disambiguated names.
// generate.ts owns the canonical short names (current binary flag spellings:
// `--save` / `--out`); run.ts's P4 versions are kept under `*Run` aliases
// for legacy consumers (office-import.ts, the P4 unit test, the integration
// round-trip test).

export * from "./run";
export * from "./generate";
export * from "./provisioning";
export * from "./office-run-images";
export * from "./capacity";
export * from "./diagnostics";

// Explicit re-exports for the clashing names. These win over the `export *`
// star re-exports (explicit named exports take precedence per the ES spec).
export { buildGetArgv, buildDumpArgv } from "./generate";
export {
  buildGetArgv as buildGetArgvRun,
  buildDumpArgv as buildDumpArgvRun,
} from "./run";
