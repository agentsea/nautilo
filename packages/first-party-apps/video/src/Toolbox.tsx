import type { ReactElement } from "react";
import type { SyntheticClipKind } from "./synthetic-clips";

export const TOOLBOX_CATEGORIES = ["Media", "Transitions", "Audio", "Text", "Effects"] as const;
export type ToolboxCategory = typeof TOOLBOX_CATEGORIES[number];

const ICON_PATHS: Record<ToolboxCategory, string> = {
  Media: "M3 4h18v16H3z M3 8h18 M7 4v4 M12 4v4 M17 4v4 M10 12l5 3-5 3z",
  Transitions: "M3 5h18v14H3z M8 5l8 14 M12 5l8 14",
  Audio: "M4 10v4 M8 6v12 M12 3v18 M16 7v10 M20 10v4",
  Text: "M4 5h16 M12 5v15 M8 20h8",
  Effects: "M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z",
};

export function ToolboxIcon({ category }: { category: ToolboxCategory }): ReactElement {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d={ICON_PATHS[category]} /></svg>;
}

export function ToolboxRail({ category, libraryOpen, onBrowse }: {
  category: ToolboxCategory;
  libraryOpen: boolean;
  onBrowse: (category: ToolboxCategory) => void;
}): ReactElement {
  return <nav className="cutting-room__tool-strip" aria-label="Editor libraries">
    {TOOLBOX_CATEGORIES.map((item) => <button key={item} type="button" aria-label={`${item} library`} aria-controls="video-toolbox-library" aria-pressed={category === item && libraryOpen} onClick={() => onBrowse(item)}><ToolboxIcon category={item} /><span>{item}</span></button>)}
  </nav>;
}

const TEXT_CHOICES: ReadonlyArray<{ kind: SyntheticClipKind; label: string; sample: string; description: string }> = [
  { kind: "title", label: "Title", sample: "Your title", description: "An opening line or a chapter heading" },
  { kind: "caption", label: "Caption", sample: "A line worth reading.", description: "A text caption you write and time" },
  { kind: "callout", label: "Callout", sample: "Look here →", description: "Draw attention to a detail" },
];

export function TextLibrary({ onAdd }: { onAdd: (kind: SyntheticClipKind) => void }): ReactElement {
  return <section className="video-toolbox-choices" aria-label="Text choices">
    <p className="video-toolbox-note">Add at the playhead, then edit the text in Properties.</p>
    {TEXT_CHOICES.map((item) => <button className="video-toolbox-tile" type="button" key={item.kind} aria-label={`Add a ${item.kind} clip`} onClick={() => onAdd(item.kind)}>
      <span className={`video-toolbox-sample video-toolbox-sample--${item.kind}`} aria-hidden="true">{item.sample}</span>
      <strong>+ {item.label}</strong><small>{item.description}</small>
    </button>)}
  </section>;
}

const UNAVAILABLE_CHOICES = {
  Transitions: ["Crossfade", "Swipe", "Fade in", "Fade out"],
  Audio: ["Audio fade in", "Audio fade out", "Audio crossfade"],
  Effects: ["Clip speed"],
} as const;

/** A library may be browsed before its effects ship, but it must not suggest
 * that an illustrative tile applies an effect to the real document. */
export function UnavailableEffectLibrary({ category }: { category: keyof typeof UNAVAILABLE_CHOICES }): ReactElement {
  return <section className="video-toolbox-choices" aria-label={`${category} choices`}>
    <p className="video-toolbox-note">{category === "Effects" ? "Clip speed changes playback speed, not project frame rate. It is not available in this build." : `${category} effects are not available in this build.`}</p>
    {UNAVAILABLE_CHOICES[category].map((label) => <div className="video-toolbox-unavailable" key={label}><ToolboxIcon category={category} /><div><strong>{label}</strong><small>Not available yet</small></div></div>)}
    {category === "Audio" ? <p className="video-toolbox-note">You can already import audio from Media, mute a track on the timeline, or select a video clip and choose Separate audio in Properties.</p> : null}
  </section>;
}
