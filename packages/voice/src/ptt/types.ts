export type PTTStatus =
  | "unavailable"
  | "waiting_for_permission"
  | "ready"
  | "listening"
  | "processing"
  | "idle"
  | "empty";

export type PTTPermission = "ACCESSIBILITY" | "SPEECH" | "MICROPHONE";

export interface PTTCallbacks {
  onTranscript: (text: string) => void;
  onStatus: (status: PTTStatus) => void;
  onPermission: (permission: PTTPermission) => void;
  onError: (message: string) => void;
}
