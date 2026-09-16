import { describe, expect, test } from "bun:test";
import { insertDroppedResourceDirective } from "../../src/components/composer/composer-resource-drop";
import {
  projectHumanMentionDirectives,
  serializeHumanMentionDirective,
} from "../../src/components/composer/human-mention-directives";
import {
  projectResourceDirectives,
  resourceEntryIdsInText,
  serializeResourceDirective,
} from "../../src/components/composer/resource-directives";

describe("composer resource drop insertion", () => {
  test("inserts at the supplied caret fallback with spacing", () => {
    expect(
      insertDroppedResourceDirective({
        text: "Read then compare",
        directive: "@[resource:entry:QFJFQURNRS5tZA]",
        root: null,
        point: { x: 0, y: 0 },
        selectionOffset: 5,
      }),
    ).toBe("Read @[resource:entry:QFJFQURNRS5tZA] then compare");
  });

  test("appends only when neither caret API nor selection is available", () => {
    expect(
      insertDroppedResourceDirective({
        text: "Read",
        directive: "@[resource:entry:QFJFQURNRS5tZA]",
        root: null,
        point: { x: 0, y: 0 },
        selectionOffset: null,
      }),
    ).toBe("Read @[resource:entry:QFJFQURNRS5tZA]");
  });

  test("keeps sequential drops before, between, and after projected chips atomic", () => {
    const first = serializeResourceDirective("217363de-daa4-4e", "@README.md");
    const second = serializeResourceDirective("33-bd80-7893dc09a62d", "@VISION.md");
    const third = serializeResourceDirective("QE5BVVRJTE8OLm1k", "@NOTES.md");
    const fourth = serializeResourceDirective("between_123", "@BETWEEN.md");
    let text = `Read ${first} then`;

    // Selection offsets are measured in short projected DOM text, not the
    // serialized directive payload. Exercise both chip boundaries and a
    // second insertion after the first has expanded the coordinate spaces.
    text = insertDroppedResourceDirective({
      text,
      directive: second,
      root: null,
      point: { x: 0, y: 0 },
      selectionOffset: projectResourceDirectives(text).indexOf("@README.md"),
    });
    const visionEnd = projectResourceDirectives(text).indexOf("@VISION.md") + "@VISION.md".length;
    text = insertDroppedResourceDirective({
      text,
      directive: fourth,
      root: null,
      point: { x: 0, y: 0 },
      selectionOffset: visionEnd,
    });
    text = insertDroppedResourceDirective({
      text,
      directive: third,
      root: null,
      point: { x: 0, y: 0 },
      selectionOffset: projectResourceDirectives(text).length,
    });

    expect(resourceEntryIdsInText(text)).toEqual(
      new Set([
        "217363de-daa4-4e",
        "33-bd80-7893dc09a62d",
        "QE5BVVRJTE8OLm1k",
        "between_123",
      ]),
    );
    expect(projectResourceDirectives(text)).toBe(
      "Read @VISION.md @BETWEEN.md @README.md then @NOTES.md",
    );
    expect(text).not.toContain("@[resource:217363de-daa4-4e:@[resource:");
  });

  test("uses the projected fallback for unicode labels without returning into a token", () => {
    const first = serializeResourceDirective("first", "@📄 résumé.md");
    const second = serializeResourceDirective("second", "@after.md");
    const text = `x ${first} y`;
    const projected = projectResourceDirectives(text);

    const inserted = insertDroppedResourceDirective({
      text,
      directive: second,
      root: null,
      point: { x: 0, y: 0 },
      selectionOffset: projected.indexOf(" y"),
    });

    expect(resourceEntryIdsInText(inserted)).toEqual(new Set(["first", "second"]));
    expect(projectResourceDirectives(inserted)).toBe("x @📄 résumé.md @after.md y");
  });

  test("keeps a Human mention atomic when a workspace document is dropped after it", () => {
    const humanId = "1fd7ff60-4891-4fe1-b405-0a672b8db057";
    const human = serializeHumanMentionDirective(humanId, "casey");
    const resource = serializeResourceDirective("d563-limit-remediation", "@D563.md");
    const text = `${human} See the doc`;

    const inserted = insertDroppedResourceDirective({
      text,
      directive: resource,
      root: null,
      point: { x: 0, y: 0 },
      selectionOffset: "@casey".length,
    });

    expect(inserted).toContain(human);
    expect(projectHumanMentionDirectives(inserted)).toEqual({
      text: `@casey ${resource} See the doc`,
      mentionedHumanUserIds: [humanId],
    });
    expect(projectResourceDirectives(projectHumanMentionDirectives(inserted).text)).toBe(
      "@casey @D563.md See the doc",
    );
  });
});
