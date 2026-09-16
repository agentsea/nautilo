/**
 * CloudConvert job tagging for user/document isolation.
 *
 * Tag format: "user:{userId}:doc:{documentId}"
 */

export interface JobTagData {
  userId: string;
  documentId: string;
}

export function createJobTag(userId: string, documentId: string): string {
  if (!userId || !documentId) {
    throw new Error("userId and documentId are required for job tagging");
  }

  const sanitizedUserId = userId.replace(/:/g, "_");
  const sanitizedDocId = documentId.replace(/:/g, "_");

  return `user:${sanitizedUserId}:doc:${sanitizedDocId}`;
}

export function parseJobTag(tag: string | null | undefined): JobTagData | null {
  if (!tag) {
    return null;
  }

  const match = tag.match(/^user:([^:]+):doc:([^:]+)$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    userId: match[1],
    documentId: match[2],
  };
}

export function verifyJobOwnership(
  tag: string | null | undefined,
  userId: string,
): boolean {
  const parsed = parseJobTag(tag);
  if (!parsed) {
    return false;
  }

  const sanitizedUserId = userId.replace(/:/g, "_");
  return parsed.userId === sanitizedUserId;
}

export function verifyJobAccess(
  tag: string | null | undefined,
  userId: string,
  documentId: string,
): boolean {
  const parsed = parseJobTag(tag);
  if (!parsed) {
    return false;
  }

  const sanitizedUserId = userId.replace(/:/g, "_");
  const sanitizedDocId = documentId.replace(/:/g, "_");

  return (
    parsed.userId === sanitizedUserId && parsed.documentId === sanitizedDocId
  );
}
