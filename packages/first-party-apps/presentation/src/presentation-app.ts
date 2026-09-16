import { prepareSlidesPdf } from "./slide-pdf";
import { MemSlidesStore } from "../engine/browser.js";
import { parseSlideHtml, serializeSlideHtml, assertSlideAdoptionPreserves } from "./slide-document";
import { SlideSession, type SlidesSaveStatus } from "./slide-session";
import type { SlidesBridge, PrepareCloseResult } from "./slide-bridge";
import { mountSlidesSurface } from "./slides-surface";
import { slidesIcon } from "./slides-icons";

export async function mountPresentation(
  root: HTMLElement,
  bridge: SlidesBridge,
  options: { mountSurface?: typeof mountSlidesSurface; preparePdf?: typeof prepareSlidesPdf } = {},
): Promise<() => void> {
  const mountSurface = options.mountSurface ?? mountSlidesSurface;
  const preview = bridge.context.mode === "preview";
  const dom = root.ownerDocument;
  let store: MemSlidesStore | undefined;
  let surface: ReturnType<typeof mountSlidesSurface> | undefined;
  let disposed = false;
  let initialized = false;
  let replacing = false;
  let actionLane: Promise<unknown> = Promise.resolve();
  let lastError = "";
  root.classList.add("presentation-app");
  const header = dom.createElement("header");
  header.className = "presentation-header";
  const identity = dom.createElement("div");
  identity.className = "presentation-identity";
  identity.append(slidesIcon(dom, "slides"));
  const appName = dom.createElement("span");
  appName.className = "presentation-app-name";
  appName.textContent = "Slides";
  const title = dom.createElement("strong");
  title.className = "presentation-document-title";
  title.textContent = "Presentation";
  const status = dom.createElement("span");
  status.className = "presentation-save-state";
  status.setAttribute("role", "status");
  status.textContent = "Opening…";
  identity.append(appName, title, status);
  const save = dom.createElement("button");
  save.type = "button";
  save.textContent = "Save";
  save.title = "Save presentation (⌘/Ctrl+S)";
  save.prepend(slidesIcon(dom, "save"));
  save.hidden = preview;
  header.append(identity, save);
  const notice = dom.createElement("div");
  notice.className = "presentation-notice";
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
  content.className = "presentation-content";
  content.setAttribute("aria-label", preview ? "Presentation preview" : "Presentation editor");
  root.replaceChildren(header, notice, content);

  function context(): void {
    if (disposed || !store) return;
    const document = store.read();
    bridge.context.set({
      selection: { slideId: surface?.getActiveSlideId() },
      summary: { documentType: "presentation", title: document.meta.title,
        slideCount: document.slides.length, dirty: preview ? false : session.dirty },
    });
  }
  function setStatus(state: SlidesSaveStatus, detail?: string): void {
    if (disposed) return;
    root.dataset["saveState"] = state;
    status.textContent = !initialized
      ? "Couldn’t open"
      : preview
        ? state === "conflict" ? "Unavailable" : state === "error" ? "Couldn’t refresh" : "Read only"
        : { saved: "Saved", unsaved: "Unsaved changes", saving: "Saving…", conflict: "Save conflict", error: "Couldn’t save" }[state];
    notice.hidden = state !== "conflict" && state !== "error" && !detail;
    message.textContent = detail ?? (state === "conflict"
      ? "This presentation changed elsewhere. Your edits are kept here. Save a copy or reload the latest version."
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
      if (state === "conflict") message.textContent = "This presentation is no longer available.";
    }
    context();
  }
  const session = new SlideSession(bridge, {
    snapshot() {
      if (!store) throw new Error("The presentation has not opened yet.");
      return serializeSlideHtml(store.read());
    },
    recoverySnapshot() {
      if (!store) throw new Error("The presentation has not opened yet.");
      return { content: serializeSlideHtml(surface?.getDraftSnapshot() ?? store.read()), exact: surface?.isDraftExact() ?? false };
    },
    replace(html) {
      const document = parseSlideHtml(html);
      const previousSlideId = surface?.getActiveSlideId();
      const activeSlideId = document.slides.some(slide => slide.id === previousSlideId) ? previousSlideId : undefined;
      const candidateStore = new MemSlidesStore(document);
      assertSlideAdoptionPreserves(document, candidateStore.read());
      const stage = dom.createElement("div");
      stage.className = "presentation-stage";
      stage.style.visibility = "hidden";
      content.append(stage);
      let candidate: ReturnType<typeof mountSlidesSurface> | undefined;
      replacing = true;
      content.inert = true;
      try {
        candidate = mountSurface(stage, candidateStore, {
          changed() { if (!preview && !replacing && !disposed && store === candidateStore) { session.changed(); context(); } },
          editing(active) { if (!preview && !replacing && !disposed && store === candidateStore) session.setLocalEditing(active); },
          error(detail) { if (!disposed) session.reportError(detail); },
          selection: context,
        }, { readOnly: preview, ...(activeSlideId ? { activeSlideId } : {}), ...(!preview && bridge.templates ? { templates: bridge.templates } : {}) });
        if (disposed) { candidate.dispose(); stage.remove(); return; }
        candidate.refresh();
        surface?.dispose();
        surface = candidate;
        store = candidateStore;
        content.replaceChildren(stage);
        stage.style.visibility = "";
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
    label(path) { title.textContent = path?.split(/[\\/]/).pop() ?? store?.readMeta().title ?? "Presentation"; context(); },
  });

  function enqueueAction<T>(work: () => Promise<T>, commit = true): Promise<T> {
    const attempt = actionLane.then(async () => {
      if (disposed) throw new Error("This presentation is closed.");
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
    dialog.className = "presentation-reload-dialog";
    const heading = dom.createElement("h2"); heading.textContent = "Reload this presentation?";
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
        if (!bridge.document.saveCopy || !store) throw new Error("Save a copy is unavailable. Keep this presentation open and retry saving.");
        let exact: string | undefined;
        await session.saveCopy(async () => {
          await surface?.commit();
          exact = serializeSlideHtml(store!.read());
        });
        if (exact === undefined || exact !== serializeSlideHtml(store.read())) throw new Error("The presentation changed while saving the copy. Keep it open and try again.");
        await session.finalizeRecoveryCopy(exact);
        result.recoverableDraftExact = exact === serializeSlideHtml(store.read());
        result.recoveryPersisted = result.recoverableDraftExact;
      } else {
        await session.save();
        result.documentSaved = session.canClose;
        result.recoverableDraftExact = false;
        if (!result.documentSaved) result.errorMessage = lastError || "Your changes have not saved. Keep this presentation open, retry or save a copy.";
      }
    } catch (error) {
      result.errorMessage = error instanceof Error ? error.message : String(error);
      session.reportError(result.errorMessage);
    }
    return result;
  }, request.action !== "save-copy"));
  const unsubscribeExport = preview ? undefined : bridge.exports?.onPrepare(request => enqueueAction(async () => {
    if (request.actionId !== "export-pdf" || request.mimeType !== "application/pdf") throw new Error("Unsupported export format.");
    if (!initialized || !store) throw new Error("Wait for this presentation to open before exporting.");
    await session.save();
    if (!session.canClose) throw new Error("Save the presentation before exporting PDF.");
    const canonical = await bridge.document.read({ fresh: true });
    const snapshot = parseSlideHtml(canonical.content);
    if (serializeSlideHtml(snapshot) !== serializeSlideHtml(store.read())) {
      throw new Error("The presentation changed elsewhere. Reload the latest version before exporting.");
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical.content));
    const sourceSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    if (sourceSha256 !== canonical.baseSha256) throw new Error("The saved presentation could not be verified.");
    const rendered = await (options.preparePdf ?? prepareSlidesPdf)(snapshot);
    if (disposed || !session.canClose || serializeSlideHtml(store.read()) !== serializeSlideHtml(snapshot)) {
      throw new Error("The presentation changed during export. Prepare a new PDF copy.");
    }
    return { ...rendered, sourceSha256 };
  }));
  try { await session.start(); }
  catch (error) { session.reportError(error); }
  return () => {
    disposed = true;
    unsubscribeClose?.();
    unsubscribeExport?.();
    dom.removeEventListener("keydown", keyboard, true);
    session.dispose(); surface?.dispose(); root.replaceChildren();
  };
}
