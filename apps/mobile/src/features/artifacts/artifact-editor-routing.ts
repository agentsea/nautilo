import type { ArtifactEditContentAdmission } from "./artifact-edit-admission";

export type ArtifactEditorRouteSelection =
  | { kind: "source" }
  | { kind: "none" };

/** Exhaustive editor boundary applied after canonical content admission. */
export function selectArtifactEditorRoute(
  admission: ArtifactEditContentAdmission,
): ArtifactEditorRouteSelection {
  if (admission.kind === "source") return { kind: "source" };
  return { kind: "none" };
}
