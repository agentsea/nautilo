import type { FC } from "react";
import type { DirectiveChipProps } from "@assistant-ui/react-lexical";
import { FileText } from "lucide-react";

export const ComposerDirectiveChip: FC<DirectiveChipProps> = ({
  directiveId,
  directiveType,
  label,
}) => {
  const isCommand = directiveType === "command";
  const isResource = directiveType === "resource";
  const isHuman = directiveType === "user";
  const displayLabel = isResource
    ? label
    : isCommand
      ? `/${directiveId}`
      : `@${isHuman ? label : directiveId}`;

  return (
    <span
      className={
        isResource
          ? "mr-1 inline-flex max-w-[12rem] items-center gap-1 rounded-md border border-accent/50 bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium leading-none text-foreground"
          : isCommand
          ? "mr-1 inline-flex max-w-[12rem] items-center rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium leading-none text-accent"
          : "mr-1 inline-flex max-w-[12rem] items-center rounded-md border border-primary/30 bg-[var(--primary-muted)] px-1.5 py-0.5 text-[11px] font-medium leading-none text-primary"
      }
      data-directive-type={directiveType}
      data-directive-id={directiveId}
      {...(isResource
        ? {
            "data-testid": "composer-resource-mention",
            "aria-label": `Focused resource ${displayLabel}`,
          }
        : {})}
      title={isResource ? displayLabel : label && label !== directiveId ? `${label} (${displayLabel})` : displayLabel}
    >
      {isResource ? <FileText aria-hidden className="h-3 w-3 shrink-0" /> : null}
      <span className="truncate">{displayLabel}</span>
    </span>
  );
};
