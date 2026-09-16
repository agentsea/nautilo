export { resolveSecurityLayers, type SecurityLevel, type SecurityLayers } from "./security-config";
export { scanCommand, normalizeCommandForDetection, DANGEROUS_PATTERNS, type CommandScanResult, type CommandPattern } from "./command-scanner";
export { checkPathAccess, type PathCheckResult } from "./path-deny";
export {
  buildProtectedPathDescriptors,
  buildProtectedPathPolicy,
  matchProtectedPath,
  isPathProtected,
  PROTECTED_PATH_POLICY_SCHEMA_VERSION,
  ProtectedPathPolicyError,
  type ProtectedPathCategory,
  type ProtectedPathOrigin,
  type ProtectedPathDescriptor,
  type ProtectedPathMatchKind,
  type ProtectedPathCheckResult,
  type ProtectedPathMatchOptions,
  type ProtectedPathCallerRootInput,
  type ProtectedPathNautiloRootsInput,
  type ProtectedPathPolicyInput,
  type ProtectedPathPolicy,
  type ProtectedPathPolicyErrorCode,
} from "./protected-path-policy";
export {
  BLOCKED_CONTENT_USER_MESSAGE,
  scanContent,
  scanToolResult,
  stripInvisibleUnicode,
  type ContentScanResult,
  type ScanResult,
  type ResultScanPolicy,
} from "./content-scanner";
export {
  resolveSeverity,
  resolveVerb,
  coerceHybridSensitivity,
  resolveHybridVerb,
  resolveApproval,
  type CombinedSeverity,
  type ApprovalVerb,
  type ToolImpact,
  type HybridSensitivity,
  type ResolveSeverityInput,
  type ResolvedApproval,
} from "./severity-resolver";
export { isExternalUnknownBinary } from "./external-binary";
// M037 — the in-memory session-scope approval store was removed. Durable
// `room`/`always` standing approvals now live in the DB via
// `@nautilo/trust` (`command-approvals.ts`).
