/** Typed boundary for the Node-compatible artifact assembler. */
export function fingerprintSource(root: string): Promise<string>;
export function buildArtifacts(
  root: string,
  destination: string,
  options?: { build?: boolean; pin?: Record<string, unknown> },
): Promise<void>;
