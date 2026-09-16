const MAX_DEVICE_VERIFICATION_URI_LENGTH = 2_048;
const MAX_DEVICE_USER_CODE_LENGTH = 128;
const DEVICE_USER_CODE_RE = /^[A-Za-z0-9-]+$/;

function hasTerminalControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

/**
 * Validate the untrusted RFC 8628 values immediately before a terminal client
 * renders them. The URI must stay on the configured issuer origin and neither
 * field may contain terminal controls.
 */
export function normalizeDeviceAuthorizationInstruction(
  issuer: string,
  verificationUri: string,
  userCode: string,
): { verificationUri: string; userCode: string } {
  if (
    verificationUri.length === 0 ||
    verificationUri.length > MAX_DEVICE_VERIFICATION_URI_LENGTH ||
    hasTerminalControlCharacters(verificationUri) ||
    userCode.length === 0 ||
    userCode.length > MAX_DEVICE_USER_CODE_LENGTH ||
    !DEVICE_USER_CODE_RE.test(userCode)
  ) {
    throw new Error("device_authorization_failed");
  }
  let expected: URL;
  let candidate: URL;
  try {
    expected = new URL(issuer);
    candidate = new URL(verificationUri);
  } catch {
    throw new Error("device_authorization_failed");
  }
  if (
    (candidate.protocol !== "http:" && candidate.protocol !== "https:") ||
    candidate.username !== "" ||
    candidate.password !== "" ||
    candidate.origin !== expected.origin
  ) {
    throw new Error("device_authorization_failed");
  }
  return { verificationUri: candidate.toString(), userCode };
}
