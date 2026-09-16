import {
  definePlatformCapabilities,
  progressive,
  supported,
  unavailable,
} from "./capability-contract";

const INSTALLED_APP_RECOVERY = "Open the installed Nautilo Mobile app for this capability.";

export const platformCapabilities = definePlatformCapabilities("web", {
  authCustody: supported(
    "Browser OIDC uses a dedicated public client with origin-scoped Logto session custody.",
  ),
  lifecycle: progressive(
    "Foreground visibility, focus, and online transitions are adapted; background execution is unavailable.",
    "Keep this tab visible and online for live updates.",
  ),
  linksAndIntents: progressive(
    "Same-origin /mobile URLs are accepted; native push, share, and device intents are rejected.",
    "Open a supported same-origin /mobile URL directly.",
  ),
  notifications: unavailable(
    "Browser push and service-worker delivery are outside Mobile Web v1.",
    "Use in-app updates while the page is open or use the installed app for push.",
  ),
  badges: unavailable(
    "Browser application badges are outside Mobile Web v1.",
    INSTALLED_APP_RECOVERY,
  ),
  cameraQr: unavailable(
    "Browser camera and QR pairing are not qualified for Mobile Web v1.",
    "Enter a supported URL manually or use the installed app.",
  ),
  chatAttachments: unavailable(
    "Ordinary browser file selection is not qualified for Mobile Web v1.",
    "Continue with text chat or use the installed app to attach media.",
  ),
  photoSelection: unavailable(
    "Browser photo selection is not qualified for Mobile Web v1.",
    "Keep the current photo or use the installed app to change it.",
  ),
  voice: unavailable(
    "Browser microphone and audio playback are not qualified for Mobile Web v1.",
    "Continue with text chat or use the installed app for voice.",
  ),
  nativeShareImport: unavailable(
    "A browser cannot claim native share-target receipt custody.",
    "Use an ordinary browser file picker where offered or use the installed app.",
  ),
  protectedFilesystem: unavailable(
    "A browser cannot claim native protected-file custody.",
    "Use server-backed Files or the installed app for device-file workflows.",
  ),
  installationIdentity: unavailable(
    "A browser cannot mint a native Mobile installation identity.",
    INSTALLED_APP_RECOVERY,
  ),
  controllerAuthority: unavailable(
    "A browser cannot create native controller proof or pairing authority.",
    INSTALLED_APP_RECOVERY,
  ),
  hostAuthority: unavailable(
    "A browser cannot claim paired-host authority through native device proof.",
    INSTALLED_APP_RECOVERY,
  ),
  externalAppHandoff: supported("Ordinary explicit browser links may open another application or origin."),
});
