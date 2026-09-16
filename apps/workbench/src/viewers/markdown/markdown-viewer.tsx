import {
  Children,
  cloneElement,
  isValidElement,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useHighlightedCode } from "../../lib/use-highlighted-code";

function codeTextFromChildren(children: ComponentPropsWithoutRef<"code">["children"]): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children
      .map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : ""))
      .join("");
  }
  return "";
}

function languageFromClassName(className: string | undefined): string | null {
  const match = /language-([A-Za-z0-9_+-]+)/.exec(className ?? "");
  return match?.[1]?.toLowerCase() ?? null;
}

function MarkdownCode(props: ComponentPropsWithoutRef<"code">) {
  const { children, className, ...rest } = props;
  const code = codeTextFromChildren(children).replace(/\n$/, "");
  const language = languageFromClassName(className);
  const isBlock = Boolean(language) || code.includes("\n");
  const highlighted = useHighlightedCode(isBlock ? code : "", isBlock ? language : null);

  if (!isBlock) {
    return (
      <code {...rest} className="rounded bg-background-element px-1">
        {children}
      </code>
    );
  }

  if (highlighted) {
    return (
      <div
        className="overflow-x-auto rounded-md border border-border bg-background-panel text-xs [&_code]:!text-xs [&_code]:block [&_code]:min-w-max [&_pre]:!m-0 [&_pre]:!min-w-full [&_pre]:!bg-background-panel [&_pre]:!p-4 [&_pre]:!text-xs"
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    );
  }

  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-background-panel p-4 !text-xs leading-relaxed text-foreground [&_code]:!text-xs">
      <code {...rest} className={className}>
        {code}
      </code>
    </pre>
  );
}

type MarkdownElementProps = {
  children?: ReactNode;
  type?: string;
  node?: { tagName?: string };
};

function ownTaskChecked(node: ExtraProps["node"]): boolean {
  const firstElement = node?.children.find((child) => child.type === "element");
  if (!firstElement) return false;
  if (firstElement.type === "element" && firstElement.tagName === "input") {
    return firstElement.properties.checked === true;
  }
  if (firstElement.type !== "element" || firstElement.tagName !== "p") return false;
  const checkbox = firstElement.children.find(
    (child) => child.type === "element" && child.tagName === "input",
  );
  return checkbox?.type === "element" && checkbox.properties.checked === true;
}

const BLOCK_TAGS = new Set([
  "blockquote",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "ol",
  "pre",
  "table",
  "ul",
]);

function renderedTagName(child: ReactNode): string | undefined {
  if (!isValidElement<MarkdownElementProps>(child)) return undefined;
  return typeof child.type === "string" ? child.type : child.props.node?.tagName;
}

function strikeTaskLine(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (isValidElement<MarkdownElementProps>(child) && child.type === "input") return child;
    return <span className="line-through">{child}</span>;
  });
}

function strikeOwnTaskContent(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (isValidElement<MarkdownElementProps>(child)) {
      const tagName = renderedTagName(child);
      if (tagName === "p") {
        return cloneElement(child, undefined, strikeTaskLine(child.props.children));
      }
      if (tagName === "input" || (tagName && BLOCK_TAGS.has(tagName))) return child;
    }
    return <span className="line-through">{child}</span>;
  });
}

function MarkdownListItem({
  children,
  node: _node,
  ...rest
}: ComponentPropsWithoutRef<"li"> & ExtraProps) {
  return <li {...rest}>{ownTaskChecked(_node) ? strikeOwnTaskContent(children) : children}</li>;
}

export function ReaderMarkdown({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-2 prose-pre:my-3 prose-ul:my-2 prose-ol:my-2 prose-headings:my-3">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: MarkdownCode,
          li: MarkdownListItem,
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
