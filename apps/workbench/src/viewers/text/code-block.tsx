import { useHighlightedCode } from "../../lib/use-highlighted-code";

export function CodeBlock({ code, language }: { code: string; language: string | null }) {
  const highlighted = useHighlightedCode(code, language);

  if (highlighted) {
    return (
      <div
        className="overflow-x-auto rounded-md border border-border bg-background-panel text-xs [&_code]:block [&_code]:min-w-max [&_pre]:!m-0 [&_pre]:!min-w-full [&_pre]:!bg-background-panel [&_pre]:!p-4"
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    );
  }

  return (
    <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-background-panel p-4 font-mono text-xs leading-relaxed text-foreground">
      {code}
    </pre>
  );
}
