/** Browser boundary: Mobile Web cannot mint native controller installation authority. */
export interface ControllerInstallation {
  readonly installationId: string;
  readonly publicKey: Uint8Array;
  sign(transcript: Uint8Array): Uint8Array;
}

export type ControllerInstallationDeps = Readonly<Record<never, never>>;

export function loadOrCreateControllerInstallation(
  _serverId: string,
  _deps?: ControllerInstallationDeps,
): Promise<ControllerInstallation> {
  return Promise.reject(new Error("Controller installation authority requires the installed Mobile app."));
}
