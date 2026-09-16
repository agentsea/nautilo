import type { ElementInit } from "@nautilo/office-slides/node";
function ofKind<K extends ElementInit["type"]>(
  value: ElementInit | undefined,
  kind: K,
): Extract<ElementInit, { type: K }> {
  if (!value || value.type !== kind)
    throw new Error(`Expected mapped ${kind}, got ${value?.type}`);
  return value as Extract<ElementInit, { type: K }>;
}
export const asShape = (value: ElementInit | undefined) =>
  ofKind(value, "shape");
export const asText = (value: ElementInit | undefined) => ofKind(value, "text");
export const asImage = (value: ElementInit | undefined) =>
  ofKind(value, "image");
