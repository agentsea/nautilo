/** Unknown runtimes have no reviewed credential owner. */
export function loadAssetBearer(_serverUrl: string): Promise<string | null> {
  return Promise.resolve(null);
}
