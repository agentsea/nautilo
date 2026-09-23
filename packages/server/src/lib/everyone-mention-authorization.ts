import { userHasCapability } from "@nautilo/trust";

export const manageRoomsRequiredForEveryoneResponse = Object.freeze({
  error: "manage_rooms_required",
  code: "manage_rooms_required",
  capability: "manage_rooms",
  message: "The manage_rooms permission is required to notify everyone in this room.",
});

export async function canNotifyEveryone(
  userId: string,
  hasCapability: typeof userHasCapability = userHasCapability,
): Promise<boolean> {
  return hasCapability(userId, "manage_rooms");
}
