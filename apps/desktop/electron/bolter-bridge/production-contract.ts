import type { BolterQualifiedDecoders } from "./cli-contract";

export const BOLTER_CLI_RELEASE = Object.freeze({
  version: "eaf521f882831d4336a3e23dcb9fbd669ad7accd",
  artifacts: Object.freeze({
    "darwin-arm64": Object.freeze({ url: "https://bolter.chat/bolter-agent/darwin-arm64",
      sha256: "b0c6b5de7115e93f7455d593d0bf45485a8a3fcb9c524f77b0920b027b2fa9d4", bytes: 6539810 }),
    "darwin-x64": Object.freeze({ url: "https://bolter.chat/bolter-agent/darwin-amd64",
      sha256: "95d66bc0849468f28726661be65fb7975ac102913bbb02d02f7dbf9f2468c5eb", bytes: 7013520 }),
  }),
});
export type BolterCliArtifact = { readonly url: string; readonly sha256: string; readonly bytes: number };

/** Empty local discovery is observed; populated/auth/receive/receipt output remains unqualified. */
export function getBolterProductionDecoders(version: string): BolterQualifiedDecoders | undefined {
  if (version !== BOLTER_CLI_RELEASE.version) return undefined;
  return Object.freeze({ version, discovery(raw: unknown): unknown {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Bolter output is unqualified.");
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).sort().join() !== "agents,harness" || !Array.isArray(value["agents"])
      || value["agents"].length !== 0 || typeof value["harness"] !== "string") throw new Error("Bolter output is unqualified.");
    return [];
  } });
}
