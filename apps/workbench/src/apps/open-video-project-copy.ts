/** Revalidate the live draft and binding after every awaited read before navigation. */
export async function openVerifiedVideoProjectCopy(input: {
  expectedSha256: string;
  isCurrent: () => boolean;
  readCurrentSha256: () => Promise<string | null>;
  verifyCopy: () => Promise<boolean>;
  open: () => void;
}): Promise<{ opened: boolean; code?: string }> {
  if (!input.isCurrent()) return { opened: false, code: "document_changed" };
  const sha256 = await input.readCurrentSha256().catch(() => null);
  if (!input.isCurrent() || sha256 !== input.expectedSha256) return { opened: false, code: "document_changed" };
  const verified = await input.verifyCopy().catch(() => false);
  if (!input.isCurrent()) return { opened: false, code: "document_changed" };
  if (!verified) return { opened: false, code: "unavailable" };
  input.open();
  return { opened: true };
}
