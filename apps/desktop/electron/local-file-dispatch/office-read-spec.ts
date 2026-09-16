/**
 * M206 — structured office.run read spec carried on the relay wire (no readArgv).
 */

export type OfficeRunReadVerb = "get" | "dump" | "view" | "query" | "validate" | "raw";

export interface OfficeRunReadSpec {
  verb: OfficeRunReadVerb;
  target?: string | undefined;
  depth?: number | undefined;
  find?: string | undefined;
  mode?: string | undefined;
  json?: boolean | undefined;
}
