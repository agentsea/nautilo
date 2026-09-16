import type { PickedAgentImage } from "./agent-avatar-source";

interface ChangeAgentPhotoSheetProps {
  visible: boolean;
  onClose: () => void;
  onPick: (asset: PickedAgentImage) => void;
  subject?: "Agent" | "Human";
}

/** Browser photo selection is not part of the qualified Mobile Web v1 surface. */
export function ChangeAgentPhotoSheet(_props: ChangeAgentPhotoSheetProps) {
  return null;
}
