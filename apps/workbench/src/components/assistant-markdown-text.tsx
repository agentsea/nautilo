import { MarkdownTextPrimitive, type MarkdownTextPrimitiveProps } from "@assistant-ui/react-markdown";
import {
  type ComponentPropsWithoutRef,
  forwardRef,
  type HTMLAttributes,
} from "react";
import remarkGfm from "remark-gfm";

type MarkdownTextContainerProps = HTMLAttributes<HTMLDivElement> & {
  "data-status"?: string;
};

const MarkdownTextContainer = forwardRef<HTMLDivElement, MarkdownTextContainerProps>(
  function MarkdownTextContainer({ "data-status": _status, ...props }, ref) {
    return <div ref={ref} {...props} />;
  },
);

type AssistantMarkdownTableProps = ComponentPropsWithoutRef<"table"> & {
  node?: unknown;
};

function AssistantMarkdownTable({
  className,
  node: _node,
  ...props
}: AssistantMarkdownTableProps) {
  return (
    <div
      className="max-w-full overflow-x-auto"
      data-assistant-markdown-table-viewport
      tabIndex={0}
    >
      <table {...props} className={["min-w-full", className].filter(Boolean).join(" ")} />
    </div>
  );
}

const ASSISTANT_REMARK_PLUGINS = [remarkGfm];
const ASSISTANT_MARKDOWN_COMPONENTS = { table: AssistantMarkdownTable };

export type AssistantMarkdownTextPrimitiveProps = Pick<
  MarkdownTextPrimitiveProps,
  "className" | "preprocess" | "smooth"
>;

/** The assistant-only Markdown boundary. Raw message text remains canonical. */
export function AssistantMarkdownTextPrimitive(
  props: AssistantMarkdownTextPrimitiveProps,
) {
  return (
    <MarkdownTextPrimitive
      {...props}
      containerComponent={MarkdownTextContainer}
      components={ASSISTANT_MARKDOWN_COMPONENTS}
      remarkPlugins={ASSISTANT_REMARK_PLUGINS}
    />
  );
}
