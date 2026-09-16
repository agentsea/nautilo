/**
 * Artifacts rail toggle (D303).
 *
 * Symmetric counterpart to RoomRail: shows/hides the Files/Artifacts panel
 * (browser column, artifacts mode) in the CURRENT room — it does not navigate,
 * so you can pop artifacts open in a group chat (e.g. to drag a file in)
 * without leaving the room. 3-state via `artifactsIconState` (open / collapsed
 * `›` / inactive). Distinct from Home, which is a nav action to your home base.
 */

import type { ReactElement } from "react";
import { Boxes } from "lucide-react";
import { LeftColumnRailToggle } from "./LeftColumnRailToggle";
import type { RailIconState } from "./left-column-nav";

export interface ArtifactsRailProps {
  state: RailIconState;
  onToggle: () => void;
}

export function ArtifactsRail({ state, onToggle }: ArtifactsRailProps): ReactElement {
  return (
    <LeftColumnRailToggle
      Icon={Boxes}
      state={state}
      onActivate={onToggle}
      ariaLabel="Artifacts — open the artifacts panel"
      titles={{
        open: "Artifacts (open)",
        collapsed: "Show artifacts",
        inactive: "Open artifacts",
      }}
      testId="artifacts-rail-toggle"
    />
  );
}
