// Modified by Nautilo: browser-compatible subset used by antlr4ts.
export type AssertionMessage = string | Error | undefined;

function ok(value: unknown, message?: AssertionMessage): asserts value {
  if (value) return;
  if (message instanceof Error) throw message;
  throw new Error(message ?? 'Assertion failed');
}

export default ok;
