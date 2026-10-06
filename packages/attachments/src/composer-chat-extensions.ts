import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, TEXT_EXTENSIONS } from "./policy";

/**
 * File extensions the Workbench composer may queue for chat, matching the
 * server gate (text, image, audio). Keep in sync with `classifyAttachment`
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

/** Client hint only; upload admission classifies the actual bytes. */
export function isComposerImageAttachment(name: string, mimeType?: string): boolean {
  return mimeType?.toLowerCase().startsWith("image/") === true
    || IMAGE_EXTENSIONS.has(extensionOfBasename(name));
}

export const IMAGE_ATTACHMENT_SELECTION_HINT =
  "This model can’t read images. Select a model that supports images to attach one.";
export const IMAGE_HISTORY_NOTICE =
  "This model can’t view earlier images. Previous text and answers are still available.";
export function imageAttachmentModelError(modelLabel: string): string {
  return `${modelLabel} can’t read the images attached to this message. Remove them or choose a model that supports images.`;
}
