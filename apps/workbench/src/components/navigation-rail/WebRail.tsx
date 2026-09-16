/**
 * Web rail toggle (D336).
 *
 * Shows/hides the Web panel (browser column, "web" mode) — the known
 * 3rd-party SaaS apps / embedded-browser surface. 3-state via `webIconState`
 * (open / collapsed `›` / inactive). Distinct from D342's "Apps" rail, which
 * is for Nautilo INSTALLED local mini-apps (different mode "apps", LayoutGrid).
 */

import type { ReactElement } from "react";
import { Globe2 } from "lucide-react";
import { LeftColumnRailToggle } from "./LeftColumnRailToggle";
import type { RailIconState } from "./left-column-nav";

export interface WebRailProps {
  state: RailIconState;
  onToggle: () => void;
}

export function WebRail({ state, onToggle }: WebRailProps): ReactElement {
  return (
    <LeftColumnRailToggle
      Icon={Globe2}
      state={state}
      onActivate={onToggle}
      ariaLabel="Web — open browser and known web apps panel"
      titles={{
        open: "Web (open)",
        collapsed: "Show web",
        inactive: "Open web",
      }}
      testId="web-rail-toggle"
    />
  );
}
