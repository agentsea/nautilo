/**
 * Native source editing passed the 10,000,018-byte iOS qualification ladder
 * with a 182 ms mount, native typing, scrolling, teardown, and remount. Keep
 * this format-specific boundary separate from the 50 MiB viewer/server
 * transport envelope and from any future structured Writer editor.
 */
export const MAX_NATIVE_SOURCE_EDIT_BYTES = 10 * 1024 * 1024;

export function nativeSourceByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
