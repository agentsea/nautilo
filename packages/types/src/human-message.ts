export function normalizeHumanMessageText(raw: string): string {
  return raw.trim();
}

export function logicalMessageKey(input: {
  id: string | number;
  role: string;
  fingerprint?: string | null;
}): string {
  if (input.role === "user" && input.fingerprint !== null && input.fingerprint !== undefined) {
    return `turn:${input.fingerprint}`;
  }
  return `row:${String(input.id)}`;
}
