/** Typed boundary for the Node-compatible owned Slides artifact assembler. */
export function fingerprintSlidesSource(root: string): Promise<string>;
export function buildSlidesArtifacts(
  root: string,
  destination: string,
  options?: { build?: boolean },
): Promise<void>;
