import { useEffect, useState } from "react";
import { readerCodeToHtml } from "./shiki-reader";

export type ReaderShikiTheme = "github-light" | "github-dark";
type ReaderCodeToHtml = typeof readerCodeToHtml;

const SHIKI_LANG_ALIASES: Record<string, string> = {
  cjs: "javascript",
  js: "javascript",
  jsx: "jsx",
  md: "markdown",
  py: "python",
  sh: "bash",
  ts: "typescript",
  tsx: "tsx",
  yml: "yaml",
};

export function shikiLangFor(language: string | null): string {
  if (!language) return "text";
  const lower = language.toLowerCase();
  return SHIKI_LANG_ALIASES[lower] ?? lower;
}

export function shikiThemeForDark(isDark: boolean): ReaderShikiTheme {
  return isDark ? "github-dark" : "github-light";
}

export function isDarkFromDocument(
  el: Pick<HTMLElement, "classList"> | null | undefined,
): boolean {
  return el?.classList.contains("dark") ?? false;
}

function getDocumentElement(): HTMLElement | null {
  return typeof document !== "undefined" ? document.documentElement : null;
}

function getThemeSnapshot(): ReaderShikiTheme {
  const el = getDocumentElement();
  return el ? shikiThemeForDark(isDarkFromDocument(el)) : "github-dark";
}

function useShikiTheme(): ReaderShikiTheme {
  const [, bump] = useState(0);

  useEffect(() => {
    const el = getDocumentElement();
    if (!el) return;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes" && mutation.attributeName === "class") {
          bump((n) => n + 1);
          return;
        }
      }
    });
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return getThemeSnapshot();
}

export function useHighlightedCode(
  code: string,
  language: string | null,
  codeToHtml: ReaderCodeToHtml = readerCodeToHtml,
): string | null {
  const theme = useShikiTheme();
  const [highlighted, setHighlighted] = useState<string | null>(null);

  useEffect(() => {
    if (!code) {
      setHighlighted(null);
      return;
    }

    let cancelled = false;
    setHighlighted(null);
    void (async () => {
      try {
        const html = await codeToHtml(code, {
          lang: shikiLangFor(language),
          theme,
        });
        if (!cancelled) setHighlighted(html);
      } catch {
        if (!cancelled) setHighlighted(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, codeToHtml, language, theme]);

  return highlighted;
}
