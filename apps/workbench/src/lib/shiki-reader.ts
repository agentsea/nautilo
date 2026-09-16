import {
  createBundledHighlighter,
  createSingletonShorthands,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import {
  READER_SHIKI_LANG_LOADERS,
  READER_SHIKI_LANGUAGES,
} from "./reader-languages";

export const readerShikiLanguageIds = READER_SHIKI_LANGUAGES;

const createReaderHighlighter = createBundledHighlighter({
  langs: READER_SHIKI_LANG_LOADERS,
  themes: {
    "github-dark": () => import("@shikijs/themes/github-dark"),
    "github-light": () => import("@shikijs/themes/github-light"),
  },
  engine: () => createJavaScriptRegexEngine(),
});

export const { codeToHtml: readerCodeToHtml } =
  createSingletonShorthands(createReaderHighlighter);
