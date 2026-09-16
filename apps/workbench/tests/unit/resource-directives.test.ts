import { describe, expect, test } from "bun:test";
import {
  parseResourceDirective,
  parseResourceDirectiveSegments,
  projectedOffsetToSerializedOffset,
  projectResourceDirectives,
  serializeResourceDirective,
} from "../../src/components/composer/resource-directives";

describe("resource directives", () => {
  test("serializes a stable id and projects only a clean label", () => {
    const directive = serializeResourceDirective("entry_123", "@README.md");
    expect(parseResourceDirective(directive)).toEqual({
      entryId: "entry_123",
      label: "@README.md",
    });
    expect(projectResourceDirectives(`Read ${directive}.`)).toBe("Read @README.md.");
    expect(projectResourceDirectives(directive)).not.toContain("entry_123");
  });

  test("only a known stored id creates a resource mention", () => {
    const directive = serializeResourceDirective("known", "@D423.md");
    expect(parseResourceDirectiveSegments(directive, (id) => id === "known")?.[0]).toMatchObject({
      kind: "mention",
      id: "known",
      type: "resource",
    });
    expect(parseResourceDirectiveSegments(directive, () => false)).toBeNull();
  });

  test("maps projected offsets around a resource chip to serialized token boundaries", () => {
    const directive = serializeResourceDirective("entry_123", "@README.md");
    const text = `Before ${directive} after`;
    const projected = projectResourceDirectives(text);
    const chipStart = projected.indexOf("@README.md");
    const rawStart = text.indexOf(directive);

    expect(projectedOffsetToSerializedOffset(text, chipStart)).toBe(rawStart);
    expect(projectedOffsetToSerializedOffset(text, chipStart + 1)).toBe(rawStart);
    expect(projectedOffsetToSerializedOffset(text, chipStart + 8)).toBe(rawStart + directive.length);
    expect(projectedOffsetToSerializedOffset(text, chipStart + "@README.md".length)).toBe(
      rawStart + directive.length,
    );
    expect(projectedOffsetToSerializedOffset(text, projected.length)).toBe(text.length);
  });
});
