/**
 * Stack 163 — shared avatar-prompt composer.
 *
 * Canonical prompt composer shared by owned-photo creation callers.
 */
export function composeAvatarPrompt(userPrompt: string): string {
  return [
    "Create a square profile avatar for a personal AI companion in Nautilo.",
    "The image must work as a small circular profile picture: centered subject, clear silhouette, expressive face or iconic character presence, simple readable background, vibrant but tasteful colors.",
    "Prefer stylized illustration, painterly, 3D character art, or polished mascot/avatar aesthetics unless the user's prompt asks otherwise.",
    "Avoid text, logos, UI, screenshots, watermarks, tiny details, or busy full-body scenes that will not read at icon size.",
    `User description: ${userPrompt}`,
  ].join(" ");
}
