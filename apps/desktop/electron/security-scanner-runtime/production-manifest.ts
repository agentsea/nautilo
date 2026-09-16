import manifestJson from "../../security-scanners/manifest.json";
import type { SecurityScannerManifest } from "./contracts.ts";
import { validateSecurityScannerManifest } from "./manifest.ts";

const parsed = validateSecurityScannerManifest(manifestJson);
if (parsed === null) throw new Error("Bundled production security-scanner manifest is invalid.");

/** Release-reviewed, exact artifact identities compiled into Desktop main. */
export const PRODUCTION_SECURITY_SCANNER_MANIFEST: SecurityScannerManifest = parsed;
