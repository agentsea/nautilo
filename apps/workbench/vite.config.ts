import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFile } from "node:fs/promises";
import { defineConfig, type Plugin } from "vite";

const OPENMLS_BROWSER_ASSETS = [
  "openmls_wasm.js",
  "openmls_wasm_bg.wasm",
] as const;

/**
 * OpenMLS is loaded lazily by lattice-crypto so Node and Electron can provide
 * their own verified runtime bytes. The Browser loader resolves the stable
 * `/vendor/openmls-wasm/` URL, so the Web build must explicitly ship the two
 * committed, reproducibility-checked artifacts at that path.
 */
export function includeOpenMlsBrowserAssets(): Plugin {
  return {
    name: "include-openmls-browser-assets",
    async buildStart() {
      for (const filename of OPENMLS_BROWSER_ASSETS) {
        const source = await readFile(
          new URL(
            `../../packages/lattice-crypto/vendor/openmls-wasm/${filename}`,
            import.meta.url,
          ),
        );
        this.emitFile({
          type: "asset",
          fileName: `vendor/openmls-wasm/${filename}`,
          source,
        });
      }
    },
  };
}

const MDXEDITOR_LEXICAL_ALIASES = {
  lexical: "@mdxeditor/lexical",
  "@lexical/clipboard": "@mdxeditor/lexical-clipboard",
  "@lexical/code": "@mdxeditor/lexical-code",
  "@lexical/devtools-core": "@mdxeditor/lexical-devtools-core",
  "@lexical/dragon": "@mdxeditor/lexical-dragon",
  "@lexical/hashtag": "@mdxeditor/lexical-hashtag",
  "@lexical/history": "@mdxeditor/lexical-history",
  "@lexical/html": "@mdxeditor/lexical-html",
  "@lexical/link": "@mdxeditor/lexical-link",
  "@lexical/list": "@mdxeditor/lexical-list",
  "@lexical/mark": "@mdxeditor/lexical-mark",
  "@lexical/markdown": "@mdxeditor/lexical-markdown",
  "@lexical/offset": "@mdxeditor/lexical-offset",
  "@lexical/overflow": "@mdxeditor/lexical-overflow",
  "@lexical/plain-text": "@mdxeditor/lexical-plain-text",
  "@lexical/react": "@mdxeditor/lexical-react",
  "@lexical/rich-text": "@mdxeditor/lexical-rich-text",
  "@lexical/selection": "@mdxeditor/lexical-selection",
  "@lexical/table": "@mdxeditor/lexical-table",
  "@lexical/text": "@mdxeditor/lexical-text",
  "@lexical/utils": "@mdxeditor/lexical-utils",
  "@lexical/yjs": "@mdxeditor/lexical-yjs",
} as const;

const mdxeditorLexicalImporter = /[/\\]@mdxeditor[/\\](?:editor|lexical(?:-[^/\\]+)?)(?:[/\\]|$)/;

function mdxeditorLexicalAlias(source: string): { alias: string; packageName: string } | undefined {
  for (const [specifier, alias] of Object.entries(MDXEDITOR_LEXICAL_ALIASES)) {
    if (source === specifier || source.startsWith(`${specifier}/`)) {
      return {
        alias: `${alias}${source.slice(specifier.length)}`,
        packageName: specifier,
      };
    }
  }
}

function packageRoot(id: string, packageName: string): string | undefined {
  const marker = `/node_modules/${packageName}/`;
  const index = id.lastIndexOf(marker);
  return index === -1 ? undefined : id.slice(0, index + marker.length - 1);
}

function isolateMdxeditorLexical(): Plugin {
  const lexicalPackageRoots = new Set<string>();

  return {
    name: "isolate-mdxeditor-lexical-035",
    enforce: "pre",
    async resolveId(source, importer) {
      const replacement = mdxeditorLexicalAlias(source);
      const isMdxeditorLexical =
        importer &&
        (mdxeditorLexicalImporter.test(importer) ||
          [...lexicalPackageRoots].some(
            (root) => importer === root || importer.startsWith(`${root}/`),
          ));
      if (!replacement || !isMdxeditorLexical) {
        return null;
      }

      const resolved = await this.resolve(replacement.alias, importer, { skipSelf: true });
      if (resolved) {
        const root = packageRoot(resolved.id, replacement.packageName);
        if (root) {
          lexicalPackageRoots.add(root);
        }
      }
      return resolved;
    },
  };
}

export default defineConfig(() => ({
  plugins: [
    includeOpenMlsBrowserAssets(),
    isolateMdxeditorLexical(),
    react(),
    tailwindcss(),
  ],
  // MDXEditor must remain unoptimized so its internal Lexical imports pass
  // through the scoped resolver; assistant-ui continues to use Lexical 0.45.
  optimizeDeps: {
    exclude: [
      "@mdxeditor/editor",
      // Silurus resolves each parser WASM relative to its direct format module.
      // Prebundling rewrites that module into .vite/deps and sends the worker to
      // an SPA fallback instead of the matching wasm asset.
      "@silurus/ooxml/docx",
      "@silurus/ooxml/xlsx",
      "@silurus/ooxml/pptx",
    ],
  },
}));
