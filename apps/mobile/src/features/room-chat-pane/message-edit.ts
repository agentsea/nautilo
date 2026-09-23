import { isSelfUserMessage, type ChatItem } from "../../lib/messages";
import { assessMobileHumanPosting, MOBILE_CONTENT_FILTER_NOTICE } from "./mobile-content-filter";

export class MobileMessageEditAdmissionError extends Error {}

export function canEditMobileMessage(
  item: Extract<ChatItem, { kind: "message" }>,
  viewerUserId: string | null,
): boolean {
  return isSelfUserMessage(item, viewerUserId)
    && item.clientId === undefined && /^\d+$/.test(item.id)
    && item.status !== "failed" && item.status !== "pending"
    && typeof item.logicalMessageKey === "string" && item.logicalMessageKey.length > 0
    && Number.isSafeInteger(item.editRevision) && (item.editRevision ?? -1) >= 0
    && (item.editContent ?? item.text).trim().length > 0;
}

export function hasMobileMessageDeleteAuthority(
  item: Extract<ChatItem, { kind: "message" }>,
  viewerUserId: string | null,
  canManageRooms: boolean,
): boolean {
  if (item.role === "user" && item.sourceUserId == null) return false;
  return isSelfUserMessage(item, viewerUserId) || canManageRooms;
}

/** Mobile has no crypto-device custody: never send an ordinary edit after
 * admission changes, or when policy cannot be established. The server remains
 * authoritative if a transition races this check. */
export async function saveMobileMessageEdit<T>(options: {
  content: string;
  filterContent: boolean;
  isCurrent: () => boolean;
  getPolicy: () => Promise<{ requiresCryptoDevice: boolean }>;
  save: () => Promise<T>;
}): Promise<T> {
  if (!options.content.trim()) throw new MobileMessageEditAdmissionError("A message can't be empty.");
  if (options.filterContent && assessMobileHumanPosting({ text: options.content }) === "blocked") {
    throw new MobileMessageEditAdmissionError(MOBILE_CONTENT_FILTER_NOTICE);
  }
  if (!options.isCurrent()) throw new MobileMessageEditAdmissionError("This conversation is no longer active.");
  const policy = await options.getPolicy();
  if (policy.requiresCryptoDevice !== false) {
    throw new MobileMessageEditAdmissionError("Encryption is not available in this app yet. Edit this message in Browser or Desktop.");
  }
  if (!options.isCurrent()) throw new MobileMessageEditAdmissionError("This conversation is no longer active.");
  return options.save();
}
