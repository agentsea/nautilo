/** Remove ANSI Select Graphic Rendition sequences for ordinary text display. */
export function stripAnsiSgr(text: string): string {
  // SGR starts with the ESC control byte; matching it is intentional here.
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-?]*m/g, "");
}
