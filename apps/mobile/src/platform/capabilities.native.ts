import { definePlatformCapabilities, supported } from "./capability-contract";

export const platformCapabilities = definePlatformCapabilities("native", {
  authCustody: supported("Native Logto sessions use the accepted SecureStore custody contract."),
  lifecycle: supported("Native AppState owns foreground and background lifecycle transitions."),
  linksAndIntents: supported("Native linking owns approved custom-scheme, push, and share intents."),
  notifications: supported("Native push registration and notification handling are available."),
  badges: supported("Native application badge reconciliation is available."),
  cameraQr: supported("Native camera permission and QR scanning are available."),
  chatAttachments: supported("Native media selection and upload are available."),
  photoSelection: supported("Native photo library and camera selection are available."),
  voice: supported("Native microphone input and audio playback are available."),
  nativeShareImport: supported("Native share-target receipt custody is available."),
  protectedFilesystem: supported("Native protected file custody is available."),
  installationIdentity: supported("Native installation identity can be stored in SecureStore."),
  controllerAuthority: supported("Native installation proof can authorize paired-controller requests."),
  hostAuthority: supported("Native paired-host handoff is available after server authorization."),
  externalAppHandoff: supported("Native operating-system application handoff is available."),
});
