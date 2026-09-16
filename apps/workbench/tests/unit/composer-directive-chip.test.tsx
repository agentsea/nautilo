import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerDirectiveChip } from "../../src/components/composer/ComposerDirectiveChip";

function render(directiveType: string, directiveId: string, label: string): string {
  return renderToStaticMarkup(
    <ComposerDirectiveChip
      directiveType={directiveType}
      directiveId={directiveId}
      label={label}
    />,
  );
}

describe("ComposerDirectiveChip", () => {
  test("renders a human mention using its label while retaining its stable ID", () => {
    const userId = "1fd7ff60-4891-4fe1-b405-0123456789ab";
    const html = render("user", userId, "casey");

    expect(html).toContain(">@casey<");
    expect(html).toContain(`data-directive-id="${userId}"`);
    expect(html).toContain('title="casey (@casey)"');
    expect(html).not.toContain(`@${userId}`);
  });

  test("keeps agent, command, and resource displays unchanged", () => {
    expect(render("agent", "nautilo", "Nautilo")).toContain(">@nautilo<");
    expect(render("command", "help", "Help")).toContain(">/help<");

    const resource = render("resource", "resource-123", "README.md");
    expect(resource).toContain(">README.md<");
    expect(resource).toContain('data-testid="composer-resource-mention"');
    expect(resource).toContain('aria-label="Focused resource README.md"');
  });
});
