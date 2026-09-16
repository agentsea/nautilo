import type { ReactNode } from "react";

export const FOOTER_SEGMENT_CLASSES =
  "inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 py-0.5";

export const FOOTER_SEGMENT_ICON_CLASSES =
  "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center";

export const FOOTER_SEGMENT_LABEL_CLASSES = "min-w-0 truncate";

export interface FooterSegmentProps {
  readonly icon?: ReactNode;
  readonly label: ReactNode;
  readonly title?: string;
  readonly className?: string;
}

export function FooterSegment({
  icon,
  label,
  title,
  className,
}: FooterSegmentProps) {
  return (
    <span
      className={
        className === undefined
          ? FOOTER_SEGMENT_CLASSES
          : `${FOOTER_SEGMENT_CLASSES} ${className}`
      }
      title={title}
    >
      {icon !== undefined && (
        <span className={FOOTER_SEGMENT_ICON_CLASSES} aria-hidden="true">
          {icon}
        </span>
      )}
      <span className={FOOTER_SEGMENT_LABEL_CLASSES}>{label}</span>
    </span>
  );
}
