import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, TEXT_EXTENSIONS } from "./policy";

/**
 * File extensions the Workbench composer may queue for chat, matching the
 * D066 server gate (text, image, audio). Keep in sync with `classifyAttachment`
 * branch order in `classify.ts` — documents/archives/scripts are never allowed here.
 */
export const COMPOSER_CHAT_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ...TEXT_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
]);

function basenameOf(pathOrName: string): string {
  return pathOrName.split(/[/\\]/).pop() ?? pathOrName;
}

/** Lowercase extension including the dot, or "" if none / dotfile-only. */
export function extensionOfBasename(pathOrName: string): string {
  const base = basenameOf(pathOrName);
  const i = base.lastIndexOf(".");
  if (i <= 0 || i === base.length - 1) {
    return "";
  }
  return base.slice(i).toLowerCase();
}

export function isComposerChatAttachmentPathAllowed(pathOrName: string): boolean {
  const ext = extensionOfBasename(pathOrName);
  if (ext === "") {
    return false;
  }
  return COMPOSER_CHAT_ATTACHMENT_EXTENSIONS.has(ext);
}
