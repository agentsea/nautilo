export type ReportVerificationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

const WINDOWS_DRIVE_PATH = /(?:^|[\s`("'=])[A-Za-z]:[\\/](?![\\/])/m;
const WINDOWS_UNC_PATH =
  /(?:^|[\s`("'=])\\\\[^\\\s`"'<>|]+\\[^\\\s`"'<>|]/m;
const FORWARD_SLASH_UNC_PATH =
  /(?:^|[\s`("'=])\/\/[^/\s`"'<>|]+\/[^/\s`"'<>|]/m;
const POSIX_ABSOLUTE_PATH =
  /(^|[\s`("'=])(\/(?!\/)[^\s`"'<>|])/gm;
const TRANSPORT_ROUTE_BEFORE_PATH =
  /(?:http:request_response|sse:(?:accepted|produced)):(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE) $/;

function containsPosixAbsolutePath(value: string): boolean {
  POSIX_ABSOLUTE_PATH.lastIndex = 0;
  for (const match of value.matchAll(POSIX_ABSOLUTE_PATH)) {
    const boundary = match[1]!;
    const slashIndex = (match.index ?? 0) + boundary.length;
    if (!TRANSPORT_ROUTE_BEFORE_PATH.test(value.slice(0, slashIndex))) return true;
  }
  return false;
}

export function verifyRenderedCoverageReport(
  current: string,
  expected: string,
): ReportVerificationResult {
  const errors: string[] = [];
  if (
    containsPosixAbsolutePath(current)
    || WINDOWS_DRIVE_PATH.test(current)
    || WINDOWS_UNC_PATH.test(current)
    || FORWARD_SLASH_UNC_PATH.test(current)
  ) {
    errors.push("generated encryption coverage report contains an absolute local path");
  }
  if (current !== expected) {
    errors.push("generated encryption coverage report is stale");
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
