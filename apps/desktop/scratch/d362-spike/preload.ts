/**
 * D362 Phase-0 spike — WebSocket tap (throwaway).
 *
 * Collabora's client talks to coolwsd over a WebSocket. JSDialog descriptors
 * (menus / dialogs / toolbars as JSON) travel on that socket. This preload
 * monkeypatches WebSocket in the webview to log text frames that look like
 * JSDialog — directly serving task 0.3.1 (capture the JSON) and 0.3.3
 * (JSDialog-vs-fork determination): eyeball how much of the UI is describable
 * as JSON vs. baked into the client.
 */
const OrigWebSocket = window.WebSocket;

class TappedWebSocket extends OrigWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    // eslint-disable-next-line no-console
    console.log("[d362-jsdialog] ws open →", String(url));
    this.addEventListener("message", (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return; // tiles are binary; skip
      if (/jsdialog|"dialog"|menubar|notebookbar|\.uno:/i.test(ev.data)) {
        // eslint-disable-next-line no-console
        console.log("[d362-jsdialog] ↓", ev.data.slice(0, 2000));
      }
    });
  }
}

// @ts-expect-error — deliberate spike-only override
window.WebSocket = TappedWebSocket;
