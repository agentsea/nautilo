/** App-owned publication truth after a remote postimage is installed. */
export function writerRemotePostimageState(rebased: boolean): {
  readonly dirty: boolean;
  readonly saveStatus: "saved" | "unsaved";
} {
  return rebased
    ? { dirty: true, saveStatus: "unsaved" }
    : { dirty: false, saveStatus: "saved" };
}
