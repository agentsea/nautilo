import "../bun-dom-preload";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createServer } from "vite";

describe("MDXEditor Lexical isolation", () => {
  test(
    "registers every Markdown node with MDXEditor's single Lexical 0.35 instance",
    async () => {
      // Prism's browser polyfill checks the global Element constructor.
      // happy-dom supplies HTMLElement but does not install Element by default.
      (globalThis as { Element?: typeof Element }).Element = globalThis.HTMLElement as typeof Element;

      const workbenchRoot = join(import.meta.dir, "../..");
      const server = await createServer({
        root: workbenchRoot,
        configFile: join(workbenchRoot, "vite.config.ts"),
        logLevel: "error",
        ssr: {
          noExternal: true,
        },
      });

      try {
        const mdxeditorEntry = import.meta.resolve("@mdxeditor/editor");
        await Promise.all(
          ["lexical", "@lexical/rich-text", "@lexical/link", "@lexical/list", "@lexical/table", "@lexical/code"].map(
            (source) => server.pluginContainer.resolveId(source, mdxeditorEntry),
          ),
        );

        // Prime each package through the same scoped resolver MDXEditor uses.
        // createEditor then validates the actual node registration invariant.
        const { createEditor } = await server.ssrLoadModule("@mdxeditor/lexical");
        const { HeadingNode, QuoteNode } = await server.ssrLoadModule("@mdxeditor/lexical-rich-text");
        const { LinkNode, AutoLinkNode } = await server.ssrLoadModule("@mdxeditor/lexical-link");
        const { ListItemNode, ListNode } = await server.ssrLoadModule("@mdxeditor/lexical-list");
        const { TableCellNode, TableNode, TableRowNode } =
          await server.ssrLoadModule("@mdxeditor/lexical-table");
        const { CodeNode } = await server.ssrLoadModule("@mdxeditor/lexical-code");

        // createEditor validates that every node inherits from its own LexicalNode.
        // Before the scoped aliases, this exact registration threw Lexical error #64.
        const editor = createEditor({
          nodes: [
            HeadingNode,
            QuoteNode,
            LinkNode,
            AutoLinkNode,
            ListNode,
            ListItemNode,
            TableNode,
            TableRowNode,
            TableCellNode,
            CodeNode,
          ],
        });

        expect(editor.hasNodes([HeadingNode, QuoteNode, LinkNode, ListNode, TableNode, CodeNode])).toBe(true);
      } finally {
        await server.close();
      }
    },
    60_000,
  );
});
