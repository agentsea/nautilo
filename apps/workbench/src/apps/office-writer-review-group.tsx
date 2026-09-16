// Wave D, D362 — Writer "Review" ribbon group (track changes).
//
// Pure, reusable React component. UI logic only — no engine/session code,
// no surface wiring. The host surface injects a `RibbonActions` handle so
// this group stays decoupled from the Collabora map / socket plumbing.
//
// Verify UNO verbs and argument shapes against the owned Office engine
// source before adding actions. See docs/office-engines/README.md.

import {
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  GitCompareArrows,
  ListChecks,
  ListX,
  X,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { RibbonGroup, toolbarButtonClass } from "./office-ribbon";
import type { RibbonActions } from "./office-ribbon";

/** Shared toolbar button for an icon-driven Writer review verb. */
function ReviewIconButton({
  title,
  Icon,
  actions,
  active,
  onClick,
}: {
  title: string;
  Icon: LucideIcon;
  actions: RibbonActions;
  active?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const isOn = active ?? false;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={isOn}
      disabled={!actions.ready}
      className={toolbarButtonClass(isOn)}
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

/**
 * §3.3.8 — track-changes controls: record toggle (STATE), navigate prev/next,
 * accept/reject current, accept/reject + advance, accept/reject all (FF).
 * `.uno:AcceptTrackedChanges` (Manage Changes dialog) is intentionally omitted.
 */
export function WriterReviewGroup({ actions }: { actions: RibbonActions }): React.JSX.Element {
  return (
    <RibbonGroup label="Review">
      <ReviewIconButton
        title="Track changes"
        Icon={GitCompareArrows}
        actions={actions}
        active={actions.isActive("TrackChanges")}
        onClick={() => actions.sendUno(".uno:TrackChanges")}
      />
      <ReviewIconButton
        title="Previous change"
        Icon={ChevronLeft}
        actions={actions}
        onClick={() => actions.sendUno(".uno:PreviousTrackedChange")}
      />
      <ReviewIconButton
        title="Next change"
        Icon={ChevronRight}
        actions={actions}
        onClick={() => actions.sendUno(".uno:NextTrackedChange")}
      />
      <ReviewIconButton
        title="Accept"
        Icon={Check}
        actions={actions}
        onClick={() => actions.sendUno(".uno:AcceptTrackedChange")}
      />
      <ReviewIconButton
        title="Reject"
        Icon={X}
        actions={actions}
        onClick={() => actions.sendUno(".uno:RejectTrackedChange")}
      />
      <ReviewIconButton
        title="Accept and move to next"
        Icon={CheckCheck}
        actions={actions}
        onClick={() => actions.sendUno(".uno:AcceptTrackedChangeToNext")}
      />
      <ReviewIconButton
        title="Reject and move to next"
        Icon={XCircle}
        actions={actions}
        onClick={() => actions.sendUno(".uno:RejectTrackedChangeToNext")}
      />
      <ReviewIconButton
        title="Accept all changes"
        Icon={ListChecks}
        actions={actions}
        onClick={() => actions.sendUno(".uno:AcceptAllTrackedChanges")}
      />
      <ReviewIconButton
        title="Reject all changes"
        Icon={ListX}
        actions={actions}
        onClick={() => actions.sendUno(".uno:RejectAllTrackedChanges")}
      />
    </RibbonGroup>
  );
}
