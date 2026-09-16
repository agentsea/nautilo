/**
 * Apps rail toggle (D342).
 *
 * Symmetric counterpart to ArtifactsRail / RoomRail: shows/hides the dedicated
 * Apps panel (browser column, "apps" mode) in the CURRENT room — it does not
 * navigate. 3-state via `appsIconState` (open / collapsed `›` / inactive).
 *
 * This is for Nautilo INSTALLED mini-apps (local, with an installer). It is a
 * distinct surface from D336's "Web" rail (3rd-party SaaS control via embedded
 * browser) — different feature, different mode ("web"), different icon (Globe2).
 */

import type { ReactElement } from "react";
import { LayoutGrid } from "lucide-react";
import { LeftColumnRailToggle } from "./LeftColumnRailToggle";
import type { RailIconState } from "./left-column-nav";

export interface AppsRailProps {
  state: RailIconState;
  onToggle: () => void;
}

export function AppsRail({ state, onToggle }: AppsRailProps): ReactElement {
  return (
    <LeftColumnRailToggle
      Icon={LayoutGrid}
      state={state}
      onActivate={onToggle}
      ariaLabel="Apps — open the installed apps panel"
      titles={{
        open: "Apps (open)",
        collapsed: "Show apps",
        inactive: "Open apps",
      }}
      testId="apps-rail-toggle"
    />
  );
}
