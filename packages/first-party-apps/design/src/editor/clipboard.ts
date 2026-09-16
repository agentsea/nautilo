import type { DesignFragment } from "../organization";

const FORMAT = "nautilo-design-fragment/1";
export const DESIGN_CLIPBOARD_MIME = "application/vnd.nautilo.design-fragment+json";

export function encodeDesignClipboard(fragment: DesignFragment): string {
  return JSON.stringify({ format: FORMAT, fragment });
}

/** Structural validation remains in the canonical insert transaction. */
export function decodeDesignClipboard(text: string): DesignFragment | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || !("format" in value) || value.format !== FORMAT || !("fragment" in value)) return null;
    const fragment = value.fragment;
    if (!fragment || typeof fragment !== "object" || !("roots" in fragment) || !("nodes" in fragment) || !Array.isArray(fragment.roots) || !Array.isArray(fragment.nodes)) return null;
    return fragment as DesignFragment;
  } catch { return null; }
}
