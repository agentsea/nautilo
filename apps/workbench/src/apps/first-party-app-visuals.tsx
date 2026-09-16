import { useState } from "react";

type FirstPartyAppVisual = {
  iconSrc: string;
  previewSrc?: string;
  previewAlt?: string;
};

const FIRST_PARTY_APP_VISUALS: Readonly<Record<string, FirstPartyAppVisual>> = {
  "nautilo-writer": {
    iconSrc: "/apps/office/writer.svg",
    previewSrc: "/apps/office/writer-preview.png",
    previewAlt: "Writer editing a Studio North creative brief with headings and formatted paragraphs",
  },
  "nautilo-design": {
    iconSrc: "/apps/office/designer.svg",
    previewSrc: "/apps/office/design-preview.png",
    previewAlt: "Nautilo Design showing a Studio North launch poster and brand palette on the canvas",
  },
  "nautilo-spreadsheet": {
    iconSrc: "/apps/office/sheets.svg",
    previewSrc: "/apps/office/sheets-preview.png",
    previewAlt: "Sheets showing a studio launch budget with formulas and spending totals",
  },
  "nautilo-presentation": {
    iconSrc: "/apps/office/slides.svg",
    previewSrc: "/apps/office/slides-preview.png",
    previewAlt: "Nautilo Slides showing a Studio North launch presentation with slide thumbnails and speaker notes",
  },
  "nautilo-board": {
    iconSrc: "/apps/office/board.svg",
    previewSrc: "/apps/office/board-preview.png",
    previewAlt: "Board showing Studio North's launch map with connected notes for the signal, story, moment, and launch week",
  },
};

export function firstPartyAppVisual(appId: string): FirstPartyAppVisual | undefined {
  return Object.prototype.hasOwnProperty.call(FIRST_PARTY_APP_VISUALS, appId)
    ? FIRST_PARTY_APP_VISUALS[appId]
    : undefined;
}

export function AppIcon({ appId, name, className = "h-full w-full" }: {
  appId: string;
  name: string;
  className?: string;
}) {
  const visual = firstPartyAppVisual(appId);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (visual && failedSrc !== visual.iconSrc) {
    return (
      <img
        src={visual.iconSrc}
        alt=""
        aria-hidden="true"
        className={`${className} object-contain`}
        onError={() => setFailedSrc(visual.iconSrc)}
      />
    );
  }
  return (
    <span aria-label={`${name} icon`} className="font-semibold">
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
