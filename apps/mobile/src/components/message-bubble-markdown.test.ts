/// <reference types="bun-types" />

import { expect, test } from "bun:test";

const source = await Bun.file(new URL("./message-bubble.tsx", import.meta.url)).text();

test("projects only stripped assistant bodies through reusable chat Markdown", async () => {
  const strip = source.indexOf("role === 'assistant' ? stripAssistantArtifacts(content) : content");
  const markdown = source.indexOf("<AssistantChatMarkdown source={displayContent} selectable={selectableContent} />");
  const userText = source.indexOf("<Text selectable style={[styles.content, isUser ? styles.contentUser");

  expect(strip).toBeGreaterThanOrEqual(0);
  expect(markdown).toBeGreaterThan(strip);
  expect(userText).toBeGreaterThan(markdown);
  expect(source).toContain("hasText && role === 'assistant'");
  expect(source).not.toContain("stripAssistantArtifacts(content).replace");
  const markdownSource = await Bun.file(new URL("./assistant-chat-markdown.tsx", import.meta.url)).text();
  expect(markdownSource).toContain('code_inline: renderCode(styles.code_inline)');
  expect(markdownSource).toContain('fence: renderCode(styles.fence)');
  expect(markdownSource).toContain('selectable={selectable}');
});

test("keeps attachments, replies, reactions, tap-revealed actions, and grouped chrome outside Markdown", () => {
  expect(source).toContain("attachments.map");
  expect(source).toContain("showQuoteHeader");
  expect(source).toContain("visibleReactions.map");
  expect(source).toContain("onPress={handleBubblePress}");
  expect(source).toContain("onActionRailReveal");
  expect(source).not.toContain("onLongPress={handleLongPress}");
  expect(source).toContain("accessible={role !== 'assistant'}");
  expect(source).not.toContain("onOpenActions?.(messageId)");
  expect(source).toContain("showIncomingChrome");
  expect(source).toContain("<MessageAvatar");
});
