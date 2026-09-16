/**
 * View-local Wafflebase spellcheck wiring for Writer (D388 spell phase).
 *
 * Creates LocalSpellProvider → SpellRouter → SpellSession, attaches via
 * `editor.setSpellSession`, debounces rechecks after edits / document swaps,
 * and exposes canvas context-menu hooks for the suggestion popover UI.
 * Spell state is never serialized to Writer documents.
 */
import {
  LocalSpellProvider,
  SpellRouter,
  SpellSession,
  getBlockText,
  type EditorAPI,
  type SpellError,
} from "@nautilo/office-docs/browser";

const RECHECK_DEBOUNCE_MS = 300;

export interface WriterSpellMenuRequest {
  error: SpellError;
  clientX: number;
  clientY: number;
}

export interface WriterSpellcheckHandle {
  scheduleRecheck: (opts?: { immediate?: boolean }) => void;
  getSession: () => SpellSession | null;
  setEnabled: (enabled: boolean) => void;
  setPersonalWords: (words: readonly string[]) => void;
  ignoreWord: (word: string) => void;
}

const handles = new WeakMap<EditorAPI, WriterSpellcheckHandle>();

/** Schedule a spell recheck after a remote document replace or similar full reload. */
export function scheduleWriterSpellRecheck(editor: EditorAPI, opts?: { immediate?: boolean }): void {
  handles.get(editor)?.scheduleRecheck(opts);
}
export function setWriterSpellcheckEnabled(editor: EditorAPI, enabled: boolean): void { handles.get(editor)?.setEnabled(enabled); }
export function setWriterSpellcheckPersonalWords(editor: EditorAPI, words: readonly string[]): void { handles.get(editor)?.setPersonalWords(words); }
export function ignoreWriterSpellWord(editor: EditorAPI, word: string): void { handles.get(editor)?.ignoreWord(word); }

export function createWriterSpellSession(editor: EditorAPI): SpellSession {
  const provider = new WriterSpellProviderAdapter();
  const router = new SpellRouter([provider]);
  return new SpellSession(router, {
    snapshot: () => editor.getStore().snapshot(),
  });
}

/**
 * Writer-owned provider seam.  The published router uses structural provider
 * methods, so this wraps (rather than mutates) the bundled provider and makes
 * personal/ignored words correct before the session performs its async work.
 */
class WriterSpellProviderAdapter {
  private readonly provider = new LocalSpellProvider();
  private readonly personalWords = new Set<string>();
  private readonly ignoredWords = new Set<string>();

  supports(language: Parameters<LocalSpellProvider["supports"]>[0]): boolean { return this.provider.supports(language); }
  async check(word: string, language: Parameters<LocalSpellProvider["check"]>[1]): Promise<boolean> {
    const normalized = normalizeSpellWord(word);
    return this.personalWords.has(normalized) || this.ignoredWords.has(normalized)
      ? true
      : this.provider.check(word, language);
  }
  async suggest(word: string, language: Parameters<LocalSpellProvider["suggest"]>[1]): Promise<string[]> {
    return this.personalWords.has(normalizeSpellWord(word)) || this.ignoredWords.has(normalizeSpellWord(word))
      ? []
      : this.provider.suggest(word, language);
  }
  setPersonalWords(words: readonly string[]): boolean {
    const nextWords = new Set<string>();
    for (const word of words) { const normalized = normalizeSpellWord(word); if (normalized) nextWords.add(normalized); }
    if (nextWords.size === this.personalWords.size && [...nextWords].every((word) => this.personalWords.has(word))) return false;
    this.personalWords.clear();
    for (const word of nextWords) this.personalWords.add(word);
    return true;
  }
  ignoreWord(word: string): boolean {
    const normalized = normalizeSpellWord(word);
    if (!normalized || this.ignoredWords.has(normalized)) return false;
    this.ignoredWords.add(normalized);
    return true;
  }
}

function collectSpellBlocks(editor: EditorAPI): Array<{ id: string; text: string }> {
  return editor.getDoc().document.blocks.map((block) => ({
    id: block.id,
    text: getBlockText(block),
  }));
}

/**
 * Attach Writer spellcheck to a mounted editor canvas. Returns a cleanup that
 * detaches the session and removes listeners (safe on unmount / doc replacement).
 */
export function attachWriterSpellcheck(
  editor: EditorAPI,
  canvasEl: HTMLElement,
  onSpellMenu: (request: WriterSpellMenuRequest | null) => void,
  opts?: { enabled?: boolean; personalWords?: readonly string[] },
): () => void {
  const provider = new WriterSpellProviderAdapter();
  provider.setPersonalWords(opts?.personalWords ?? []);
  let session = new SpellSession(new SpellRouter([provider]), {
    snapshot: () => editor.getStore().snapshot(),
  });
  editor.setSpellSession(session);

  let disposed = false;
  let spellCheckEnabled = opts?.enabled ?? true;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let recheckGeneration = 0;
  let recheckInFlight: Promise<void> | null = null;
  const nativeSetSpellCheckEnabled = editor.setSpellCheckEnabled.bind(editor);
  const resetSession = () => {
    session = new SpellSession(new SpellRouter([provider]), { snapshot: () => editor.getStore().snapshot() });
    editor.setSpellSession(session);
  };

  const runRecheck = async (): Promise<void> => {
    if (disposed || !spellCheckEnabled) return;
    const gen = ++recheckGeneration;
    recheckInFlight = session.recheckBlocks(collectSpellBlocks(editor), {
      composing: editor.isComposing(),
    });
    try {
      await recheckInFlight;
    } finally {
      recheckInFlight = null;
    }
    if (!disposed && gen === recheckGeneration && spellCheckEnabled) {
      editor.render();
    }
  };

  const scheduleRecheck = (opts?: { immediate?: boolean }) => {
    if (disposed || !spellCheckEnabled) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (opts?.immediate) {
      void runRecheck();
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runRecheck();
    }, RECHECK_DEBOUNCE_MS);
  };

  const setEnabled = (enabled: boolean) => {
    if (spellCheckEnabled === enabled) return;
    spellCheckEnabled = enabled;
    nativeSetSpellCheckEnabled(enabled);
    if (!enabled) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      recheckGeneration++;
      onSpellMenu(null);
      return;
    }
    void runRecheck();
  };
  const setPersonalWords = (words: readonly string[]) => {
    if (!provider.setPersonalWords(words)) return;
    resetSession();
    if (spellCheckEnabled) void runRecheck();
  };
  const ignoreWord = (word: string) => { if (provider.ignoreWord(word)) { resetSession(); if (spellCheckEnabled) void runRecheck(); } };
  const handle: WriterSpellcheckHandle = { scheduleRecheck, getSession: () => (disposed ? null : session), setEnabled, setPersonalWords, ignoreWord };
  handles.set(editor, handle);
  nativeSetSpellCheckEnabled(spellCheckEnabled);
  if (spellCheckEnabled) void runRecheck();
  editor.setSpellCheckEnabled = (enabled: boolean) => { setEnabled(enabled); };

  const onContextMenu = (event: MouseEvent) => {
    if (disposed || !spellCheckEnabled) {
      event.stopPropagation();
      return;
    }
    const error = editor.getSpellErrorAt(event.clientX, event.clientY);
    if (error) {
      event.preventDefault();
      event.stopPropagation();
      onSpellMenu({ error, clientX: event.clientX, clientY: event.clientY });
      return;
    }
    // Block the engine's blanket preventDefault so the native menu can appear.
    event.stopPropagation();
  };
  canvasEl.addEventListener("contextmenu", onContextMenu, { capture: true });

  return () => {
    disposed = true;
    handles.delete(editor);
    recheckGeneration++;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    onSpellMenu(null);
    canvasEl.removeEventListener("contextmenu", onContextMenu, { capture: true });
    editor.setSpellCheckEnabled = nativeSetSpellCheckEnabled;
    editor.setSpellSession(null);
  };
}
function normalizeSpellWord(value: string): string { return value.normalize("NFC").trim().toLocaleLowerCase(); }
