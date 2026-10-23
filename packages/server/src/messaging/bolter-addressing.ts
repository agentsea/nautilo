import type { BolterReceivedMessage } from "@nautilo/types";

const alias = /^[a-f0-9]{8}$/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

function sameAgent(mentionedId: string, providerAgentId: string): boolean {
  const mentioned = mentionedId.toLowerCase();
  const bound = providerAgentId.toLowerCase();
  if (mentioned === bound) return true;
  // The qualified CLI identifies agents by eight-hex aliases; picker mentions use full UUIDs.
  return (alias.test(bound) && uuid.test(mentioned) && mentioned.startsWith(`${bound}-`))
    || (alias.test(mentioned) && uuid.test(bound) && bound.startsWith(`${mentioned}-`));
}

/** Recipient selection never replaces the binding, sponsorship or Namespace checks. */
export function isBolterMessageAddressed(
  message: Pick<BolterReceivedMessage, "senderType" | "addressed" | "content">,
  providerAgentId: string,
): boolean {
  if (message.senderType === "system" || (message.senderType === "anima" && !message.addressed)) return false;
  // Use the picker's canonical agent IDs, not mutable labels or incidental names in prose.
  const mentions = [...message.content.matchAll(/\[@[^\]\r\n]+\]\(#mention-aid:([a-f0-9]{8}(?:-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?)\)/giu)];
  if (mentions.length > 0) return mentions.some(mention => sameAgent(mention[1]!, providerAgentId));
  // Keep ordinary Human conversation working; other agents still require provider addressivity.
  return true;
}
