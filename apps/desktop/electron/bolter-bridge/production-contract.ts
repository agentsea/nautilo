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

/** Empty discovery and the initial login prompt are observed; messaging and identity outputs remain unqualified. */
export function getBolterProductionDecoders(version: string): BolterQualifiedDecoders | undefined {
  if (version !== BOLTER_CLI_RELEASE.version) return undefined;
  return Object.freeze({ version, discovery(raw: unknown): unknown {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Bolter output is unqualified.");
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).sort().join() !== "agents,harness" || !Array.isArray(value["agents"])
      || value["agents"].length !== 0 || typeof value["harness"] !== "string") throw new Error("Bolter output is unqualified.");
    return [];
  }, authLink(stdout: string): unknown {
    // Parse only the complete observed prompt. Provider prose is never executable authority.
    const prompt = /^Open this link on any device to sign in \(or create a Bolter account\): https:\/\/bolter\.chat\/device\?code=([A-Z]{4}-[A-Z]{4})\nCheck that the page shows the code ([A-Z]{4}-[A-Z]{4})\. If this command is stopped, run it again to keep waiting on the same code\.\n$/u.exec(stdout);
    if (!prompt || prompt[0] !== stdout || prompt[1] !== prompt[2]) throw new Error("Bolter output is unqualified.");
    return Object.freeze({ url: `https://bolter.chat/device?code=${prompt[1]}`, code: prompt[1] });
  } });
}
