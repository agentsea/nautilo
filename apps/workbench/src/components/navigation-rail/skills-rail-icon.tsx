import type { SVGProps } from "react";

/**
 * D263 — Skills rail glyph (✸). Unicode in a Lucide-sized box so the
 * rail stays icon-consistent without pulling in a mismatched pictogram.
 */
export function SkillsRailIcon(props: SVGProps<SVGSVGElement>) {
  const { className, ...rest } = props;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      <path d="M12 3.5 13.8 9.2 19.5 11 13.8 12.8 12 18.5 10.2 12.8 4.5 11 10.2 9.2Z" />
      <path d="M12 3.5v3M12 18.5v2.5M4.5 11H2M19.5 11H22M6.2 6.2 4.4 4.4M17.8 6.2l1.8-1.8M6.2 15.8l-1.8 1.8M17.8 15.8l1.8 1.8" />
    </svg>
  );
}
