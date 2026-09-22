import { forwardRef, type HTMLAttributes } from "react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { formatUserAttachmentDisplay } from "../lib/user-attachment-display";

type MarkdownTextContainerProps = HTMLAttributes<HTMLDivElement> & {
  "data-status"?: string;
};

const MarkdownTextContainer = forwardRef<HTMLDivElement, MarkdownTextContainerProps>(
  function MarkdownTextContainer({ "data-status": _status, ...props }, ref) {
    return <div ref={ref} {...props} />;
  },
);

export function UserText() {
  return (
    <div className="prose prose-sm max-w-none text-sm dark:prose-invert prose-p:my-0 prose-pre:my-2 prose-ul:my-1 prose-ol:my-1 prose-headings:my-2">
      <MarkdownTextPrimitive
        preprocess={formatUserAttachmentDisplay}
        containerComponent={MarkdownTextContainer}
        remarkPlugins={[remarkGfm]}
        smooth={false}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      />
    </div>
  );
}
