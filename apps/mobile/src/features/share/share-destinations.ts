export function isConversationAttachmentMimeType(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase();
  return normalized.startsWith("image/")
    || normalized.startsWith("audio/")
    || normalized.startsWith("text/");
}

export function conversationAttachmentAvailability(
  mimeType: string,
): Readonly<{ available: boolean; reason: "format" | null }> {
  if (!isConversationAttachmentMimeType(mimeType)) {
    return { available: false, reason: "format" };
  }
  return { available: true, reason: null };
}
