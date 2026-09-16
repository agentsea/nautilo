/**
 * D144-P2 — re-export shared artifact save helper from `@nautilo/api-client`
 * so workbench call sites can import a stable local path.
 */
export { saveArtifactToDisk } from "@nautilo/api-client/browser";
export type { NautiloDesktopArtifactSaveBridge } from "@nautilo/api-client/browser";
