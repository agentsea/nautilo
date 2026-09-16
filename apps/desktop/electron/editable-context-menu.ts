/** D519 — Electron binding for the pure editable-text context menu policy. */

import { Menu, type BaseWindow, type ContextMenuParams, type WebContents } from "electron";
import {
  buildEditableContextMenuPolicy,
  type EditableContextMenuDescriptor,
  type EditableContextMenuPlatform,
} from "./editable-context-menu-policy";

type EventFrame = NonNullable<ContextMenuParams["frame"]>;

export type EditableContextMenuHost = Readonly<{
  getWindow: () => BaseWindow | null;
  platform: EditableContextMenuPlatform;
}>;

/**
 * Attaches one context-menu listener to one Workbench renderer. The disposer
 * is idempotent and is also invoked on WebContents destruction.
 */
export function attachEditableContextMenu(
  contents: WebContents,
  host: EditableContextMenuHost,
): () => void {
  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    contents.removeListener("context-menu", onContextMenu);
  };

  const onContextMenu = (_event: Electron.Event, params: ContextMenuParams): void => {
    if (disposed || contents.isDestroyed()) return;
    const frame = validFrame(params.frame);
    const descriptors = buildEditableContextMenuPolicy({
      isEditable: params.isEditable,
      selectionText: params.selectionText,
      mediaType: params.mediaType,
      linkURL: params.linkURL,
      misspelledWord: params.misspelledWord,
      dictionarySuggestions: params.dictionarySuggestions,
      editFlags: params.editFlags,
      frameAvailable: frame !== null,
      platform: host.platform,
    });
    if (descriptors.length === 0 || frame === null) return;

    const window = host.getWindow();
    if (!window || window.isDestroyed()) return;

    const menu = Menu.buildFromTemplate(
      descriptors.map((descriptor) => toElectronMenuItem(descriptor, contents, frame)),
    );
    // The event's frame is essential for macOS responder-chain features. It
    // is revalidated above and by each custom callback below to prevent stale
    // correction/learning after navigation or renderer teardown.
    menu.popup({
      window,
      frame,
      x: params.x,
      y: params.y,
      sourceType: params.menuSourceType,
    });
  };

  contents.on("context-menu", onContextMenu);
  contents.once("destroyed", dispose);
  return dispose;
}

function toElectronMenuItem(
  descriptor: EditableContextMenuDescriptor,
  contents: WebContents,
  frame: EventFrame,
): Electron.MenuItemConstructorOptions {
  switch (descriptor.kind) {
    case "separator":
      return { type: "separator" };
    case "suggestion":
      return {
        label: descriptor.replacement,
        click: () => {
          if (!canActOnOrigin(contents, frame)) return;
          contents.replaceMisspelling(descriptor.replacement);
        },
      };
    case "learn":
      return {
        label: "Learn Spelling",
        click: () => {
          if (!canActOnOrigin(contents, frame)) return;
          contents.session.addWordToSpellCheckerDictionary(descriptor.word);
        },
      };
    case "edit":
      return {
        role: descriptor.action,
        enabled: descriptor.enabled,
      };
  }
}

function validFrame(frame: ContextMenuParams["frame"]): EventFrame | null {
  if (!frame || frame.isDestroyed() || frame.detached) return null;
  return frame;
}

function canActOnOrigin(contents: WebContents, frame: EventFrame): boolean {
  return !contents.isDestroyed() && !frame.isDestroyed() && !frame.detached;
}
