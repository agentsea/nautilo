const REQUIRED_FRONTMATTER_KEYS = [
  "name",
  "description",
  "source",
  "version",
] as const;

type RequiredFrontmatterKey = (typeof REQUIRED_FRONTMATTER_KEYS)[number];

export function parseFrontmatter(raw: string): {
  frontmatter: Record<RequiredFrontmatterKey, string>;
  body: string;
} {
  if (!raw.startsWith("---\n")) {
    throw new Error("Bundled command markdown must start with a frontmatter block (---)");
  }

  const closingIndex = raw.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    throw new Error("Bundled command markdown has a malformed or unclosed frontmatter block");
  }

  const frontmatterBlock = raw.slice(4, closingIndex);
  const body = raw.slice(closingIndex + 5).replace(/^\n+/, "");

  const frontmatter: Partial<Record<RequiredFrontmatterKey, string>> = {};
  for (const line of frontmatterBlock.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      throw new Error(`Invalid frontmatter line (expected key: value): ${line}`);
    }
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    frontmatter[key as RequiredFrontmatterKey] = value;
  }

  for (const key of REQUIRED_FRONTMATTER_KEYS) {
    if (frontmatter[key] === undefined) {
      throw new Error(`Bundled command frontmatter is missing required key: ${key}`);
    }
  }

  return {
    frontmatter: frontmatter as Record<RequiredFrontmatterKey, string>,
    body,
  };
}
