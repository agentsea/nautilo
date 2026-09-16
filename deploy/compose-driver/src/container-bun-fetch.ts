/**
 * Build a dependency-closed HTTP probe for execution inside nautilo-server.
 * The hardened runtime guarantees Bun, but deliberately does not ship curl.
 */
export const CONTAINER_BUN_FETCH_SCRIPT = [
  "const [url, method, headersJson, hasBody] = process.argv.slice(1);",
  "if (!url || !method || !headersJson || !hasBody) throw new Error('missing container fetch arguments');",
  "const headers = JSON.parse(headersJson);",
  "const body = hasBody === '1' ? await Bun.stdin.text() : undefined;",
  "const response = await fetch(url, { method, headers, body, redirect: 'error' });",
  "const text = await response.text();",
  "process.stdout.write(`${text}\\n${response.status}`);",
].join(" ");

export function buildContainerBunFetchArgs(input: {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly hasBody?: boolean;
}): string[] {
  return [
    "bun",
    "-e",
    CONTAINER_BUN_FETCH_SCRIPT,
    "--",
    input.url,
    input.method ?? "GET",
    JSON.stringify(input.headers ?? {}),
    input.hasBody === true ? "1" : "0",
  ];
}
