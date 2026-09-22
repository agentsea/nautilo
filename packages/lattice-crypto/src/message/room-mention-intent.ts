import {
  CanonicalDecodingError,
  frameText,
  type StrictDecoder,
} from "../format/v2-primitives.ts";

const EVERYONE_EXTENSION = "room_mentions.everyone.v1";

/** An opt-in, signed plan extension. Unaddressed plans keep their exact bytes. */
export function normalizeRoomMentionIntent(value: {
  readonly mentionEveryone?: true;
}): { readonly mentionEveryone?: true } {
  if (value.mentionEveryone === undefined) return {};
  if (value.mentionEveryone !== true) {
    throw new TypeError("Room mention intent must be true or absent");
  }
  return { mentionEveryone: true };
}

export function encodeRoomMentionIntent(value: {
  readonly mentionEveryone?: true;
}): Uint8Array {
  return value.mentionEveryone === true
    ? frameText(EVERYONE_EXTENSION) : new Uint8Array();
}

export function readRoomMentionIntent(
  reader: StrictDecoder,
): { readonly mentionEveryone?: true } {
  if (reader.remaining === 0) return {};
  if (reader.readText(EVERYONE_EXTENSION.length) !== EVERYONE_EXTENSION) {
    throw new CanonicalDecodingError("Unknown Room mention intent");
  }
  return { mentionEveryone: true };
}
