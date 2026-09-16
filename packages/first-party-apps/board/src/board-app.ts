import { parseBoardHtml, serializeBoardHtml, assertBoardAdoptionPreserves } from "./board-document";
import { BoardSession, type BoardSaveStatus } from "./board-session";
import type { BoardBridge, PrepareCloseResult } from "./board-bridge";
import { mountBoardSurface } from "./board-surface";

export async function mountBoard(
  root: HTMLElement,
  bridge: BoardBridge,
  options: { mountSurface?: typeof mountBoardSurface } = {},
): Promise<() => void> {
  const mountSurface = options.mountSurface ?? mountBoardSurface;
  const preview = bridge.context.mode === "preview";
  const dom = root.ownerDocument;
  let surface: ReturnType<typeof mountBoardSurface> | undefined;
  let disposed = false;
  let initialized = false;
  let replacing = false;
  let actionLane: Promise<unknown> = Promise.resolve();
  let lastError = "";
  root.classList.add("board-host");
  function palette(): "light" | "dark" {
    const theme = dom.documentElement.dataset.theme;
    return theme === "dark" || (theme === undefined && dom.defaultView?.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  }
  const themeObserver = new dom.defaultView!.MutationObserver(() => surface?.setTheme(palette()));
  themeObserver.observe(dom.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  let label = "Board";
  let statusText = "Opening…";
  let publishedContext = "";
  const save = dom.createElement("button");
  save.type = "button";
  save.className = "bd-button";
  save.textContent = "Save";
  save.title = "Save board (⌘/Ctrl+S)";
  save.hidden = preview;
  const notice = dom.createElement("div");
  notice.className = "board-notice";
  notice.hidden = true;
  notice.setAttribute("role", "status");
  const message = dom.createElement("span");
  const retry = dom.createElement("button");
  retry.type = "button";
  retry.textContent = "Retry save";
  const copy = dom.createElement("button");
  copy.type = "button";
  copy.textContent = "Save a copy";
  const reload = dom.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload latest";
  notice.append(message, retry, copy, reload);
  const content = dom.createElement("main");
  content.className = "board-content";
  content.setAttribute("aria-label", preview ? "Board preview" : "Board editor");
  root.replaceChildren(notice, content);

  function snapshot(): string {
    if (!surface) throw new Error("The board has not opened yet.");
    return serializeBoardHtml(surface.read());
  }
  function context(): void {
    if (disposed || !surface) return;
    const document = surface.read();
    const value = {
      selection: { elementIds: surface.selection() },
      summary: { documentType: "board", title: document.meta.title,
        topLevelElementCount: document.elements.length, dirty: preview ? false : session.dirty },
    };
    const key = JSON.stringify(value);
    if (key === publishedContext) return;
    publishedContext = key;
    bridge.context.set(value);
  }
  function setStatus(state: BoardSaveStatus, detail?: string): void {
    if (disposed) return;
    root.dataset["saveState"] = state;
    statusText = !initialized
      ? "Couldn’t open"
      : preview
        ? state === "conflict" ? "Unavailable" : state === "error" ? "Couldn’t refresh" : "Read only"
        : { saved: "Saved", unsaved: "Unsaved changes", saving: "Saving…", conflict: "Save conflict", error: "Couldn’t save" }[state];
    surface?.setStatus(statusText);
    notice.hidden = state !== "conflict" && state !== "error" && !detail;
    message.textContent = detail ?? (state === "conflict"
      ? "This board changed elsewhere. Your edits are kept here. Save a copy or reload the latest version."
      : "Your edits are kept here. Retry saving when the connection is available.");
    lastError = state === "error" || state === "conflict" ? message.textContent : "";
    retry.hidden = state === "conflict" || !initialized;
    copy.hidden = !initialized;
    reload.textContent = initialized ? "Reload latest" : "Retry opening";
    save.disabled = state === "conflict" || !initialized;
    if (preview) {
      retry.hidden = true;
      copy.hidden = true;
      reload.hidden = state !== "conflict" && state !== "error" && !detail;
      if (state === "conflict") message.textContent = "This board is no longer available.";
    }
    context();
  }
  const session = new BoardSession(bridge, {
    snapshot,
    recoverySnapshot() {
      return { content: snapshot(), exact: surface !== undefined && !surface.hasPendingImages() };
    },
    replace(html) {
      const document = parseBoardHtml(html);
      const stage = dom.createElement("div");
      stage.className = "board-stage";
      stage.style.visibility = "hidden";
      content.append(stage);
      let candidate: ReturnType<typeof mountBoardSurface> | undefined;
      replacing = true;
      content.inert = true;
      try {
        candidate = mountSurface(stage, document, {
          changed() { if (!preview && !replacing && !disposed && surface === candidate) { session.changed(); context(); } },
          editing(active) { if (!preview && !replacing && !disposed && surface === candidate) session.setLocalEditing(active); },
          error(detail) { if (!disposed) session.reportError(detail); },
          selection() { if (!replacing) context(); },
        }, { readOnly: preview, status: statusText, theme: palette(), viewport: surface?.viewport(), selection: surface?.selection() });
        assertBoardAdoptionPreserves(document, candidate.read());
        if (disposed) { candidate.dispose(); stage.remove(); return; }
        candidate.setActions([save]);
        surface?.dispose();
        surface = candidate;
        content.replaceChildren(stage);
        stage.style.visibility = "";
        surface.setTitle(label || document.meta.title);
        initialized = true;
      } catch (error) {
        candidate?.dispose();
        stage.remove();
        throw error;
      } finally {
        replacing = false;
        content.inert = false;
      }
    },
    status: setStatus,
    label(path) { label = path?.split(/[\\/]/).pop() ?? surface?.read().meta.title ?? "Board"; surface?.setTitle(label); context(); },
  });

  function enqueueAction<T>(work: () => Promise<T>, commit = true): Promise<T> {
    const attempt = actionLane.then(async () => {
      if (disposed) throw new Error("This board is closed.");
      content.inert = true;
      try { if (commit) await surface?.commit(); return await work(); }
      finally { content.inert = false; }
    });
    actionLane = attempt.catch(() => {});
    return attempt;
  }
  async function action(work: () => Promise<void>, commit = true): Promise<void> {
    try { await enqueueAction(work, commit); }
    catch (error) { session.reportError(error); }
  }
  if (!preview) {
    save.onclick = retry.onclick = () => { void action(() => session.save()); };
    copy.onclick = () => { void action(() => session.saveCopy(() => surface?.commit()), false); };
  }
  // Reload intentionally discards the local draft only after an explicit choice.
  reload.onclick = () => {
    if (preview) { void action(() => session.reload()); return; }
    if (!initialized) { void action(() => session.start()); return; }
    const dialog = dom.createElement("dialog");
    dialog.className = "board-reload-dialog";
    const heading = dom.createElement("h2"); heading.textContent = "Reload this board?";
    const description = dom.createElement("p"); description.textContent = "Your unsaved changes will be replaced by the latest saved version. Save a copy first if you want to keep them.";
    const keep = dom.createElement("button"); keep.type = "button"; keep.textContent = "Keep editing";
    const discard = dom.createElement("button"); discard.type = "button"; discard.textContent = "Reload latest";
    keep.onclick = () => dialog.close();
    discard.onclick = () => { dialog.close(); void action(() => session.reload()); };
    dialog.onclose = () => { dialog.remove(); reload.focus(); };
    dialog.append(heading, description, keep, discard);
    root.append(dialog); dialog.showModal(); keep.focus();
  };
  const keyboard = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      if (!preview) void action(() => session.save());
    }
  };
  dom.addEventListener("keydown", keyboard, true);
  const unsubscribeClose = preview ? undefined : bridge.lifecycle?.onPrepareClose(request => enqueueAction(async () => {
    if (!initialized) return { noLocalChanges: true, documentSaved: false, recoveryPersisted: false, recoverableDraftExact: false };
    const result: PrepareCloseResult = { documentSaved: false, recoveryPersisted: false, recoverableDraftExact: false };
    try {
      if (request.action === "save-copy") {
        if (!bridge.document.saveCopy || !surface) throw new Error("Save a copy is unavailable. Keep this board open and retry saving.");
        let exact: string | undefined;
        await session.saveCopy(async () => {
          await surface?.commit();
          exact = snapshot();
        });
        if (exact === undefined || exact !== snapshot()) throw new Error("The board changed while saving the copy. Keep it open and try again.");
        await session.finalizeRecoveryCopy(exact);
        result.recoverableDraftExact = exact === snapshot();
        result.recoveryPersisted = result.recoverableDraftExact;
      } else {
        await session.save();
        result.documentSaved = session.canClose;
        result.recoverableDraftExact = false;
        if (!result.documentSaved) result.errorMessage = lastError || "Your changes have not saved. Keep this board open, retry or save a copy.";
      }
    } catch (error) {
      result.errorMessage = error instanceof Error ? error.message : String(error);
      session.reportError(result.errorMessage);
    }
    return result;
  }, request.action !== "save-copy"));
  try { await session.start(); }
  catch (error) { session.reportError(error); }
  return () => {
    disposed = true;
    unsubscribeClose?.();
    dom.removeEventListener("keydown", keyboard, true);
    themeObserver.disconnect();
    session.dispose(); surface?.dispose(); root.replaceChildren();
  };
}
