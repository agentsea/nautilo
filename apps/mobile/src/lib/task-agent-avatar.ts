/**
 * D547 — canonical authenticated image path for the exact Genie responsible
 * for a Task. Keep this transport helper pure: auth headers and cache policy
 * belong to the image loader, while the server owns profile/media resolution.
 */
export function taskAgentAvatarPath(taskId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/agent/avatar`;
}
