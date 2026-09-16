import {
  MarkdownIt,
  type MarkdownParser,
} from "react-native-markdown-display";

// The renderer package's legacy declaration error-types this factory, while
// MarkdownParser accurately describes the interface it consumes.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
export const MOBILE_MARKDOWN_PARSER: MarkdownParser = MarkdownIt({
  html: false,
  linkify: false,
  typographer: true,
});
