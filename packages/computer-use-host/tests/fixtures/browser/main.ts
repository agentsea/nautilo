import { createServer } from "node:http";

import { app, BrowserWindow } from "electron";

const cdpPort = Number(process.env["NAUTILO_CUA_FIXTURE_CDP_PORT"]);
if (!Number.isSafeInteger(cdpPort) || cdpPort < 1 || cdpPort > 65_535) {
  throw new Error("NAUTILO_CUA_FIXTURE_CDP_PORT must be a valid explicit port");
}
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));

const page = (next: boolean): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${next ? "Cua Browser Fixture Next" : "Cua Browser Fixture"}</title></head>
<body>
  <main>
    <h1>${next ? "Navigation complete" : "Owned Cua browser fixture"}</h1>
    ${next ? '<p id="destination">Fresh navigation state</p>' : `
      <label for="exact-text">Exact text</label>
      <input id="exact-text" type="text" autocomplete="off">
      <p id="mirror" aria-live="polite">Mirror: empty</p>
      <button id="increment" type="button">Increment</button>
      <p id="count" aria-live="polite">Count: 0</p>
      <button id="pointer-target" type="button">Pointer target</button>
      <p id="pointer-state" aria-live="polite">Pointer: idle</p>
      <div id="drag-source" role="button" tabindex="0" draggable="true" style="width:120px;height:50px;cursor:pointer">Drag source</div>
      <div id="drop-target" role="button" tabindex="0" style="width:120px;height:50px;cursor:pointer">Drop target</div>
      <p id="drag-state" aria-live="polite">Drag: idle</p>
      <div id="scroll-target" role="region" aria-label="Scrollable fixture" style="height:80px;overflow-y:auto;border:1px solid">
        <div style="height:500px">Scroll content</div>
      </div>
      <p id="scroll-state" aria-live="polite">Scroll: 0</p>
      <button id="dialog-target" type="button">Open alert</button>
      <p id="dialog-state" aria-live="polite">Dialog: idle</p>
    `}
  </main>
  <script>
    const input = document.getElementById('exact-text');
    if (input) input.addEventListener('input', () => { document.getElementById('mirror').textContent = 'Mirror: ' + input.value; });
    const button = document.getElementById('increment');
    if (button) button.addEventListener('click', () => {
      const count = document.getElementById('count');
      const value = Number(count.textContent.replace('Count: ', '')) + 1;
      count.textContent = 'Count: ' + value;
    });
    const pointer = document.getElementById('pointer-target');
    if (pointer) pointer.addEventListener('pointerover', () => { document.getElementById('pointer-state').textContent = 'Pointer: hovered'; });
    if (pointer) pointer.addEventListener('contextmenu', (event) => { event.preventDefault(); document.getElementById('pointer-state').textContent = 'Pointer: right-clicked'; });
    if (pointer) pointer.addEventListener('dblclick', () => { document.getElementById('pointer-state').textContent = 'Pointer: double-clicked'; });
    const drop = document.getElementById('drop-target');
    if (drop) drop.addEventListener('dragover', (event) => event.preventDefault());
    if (drop) drop.addEventListener('drop', (event) => { event.preventDefault(); document.getElementById('drag-state').textContent = 'Drag: dropped'; });
    const scroll = document.getElementById('scroll-target');
    if (scroll) scroll.addEventListener('scroll', () => { document.getElementById('scroll-state').textContent = 'Scroll: ' + scroll.scrollTop; });
    const dialog = document.getElementById('dialog-target');
    if (dialog) dialog.addEventListener('click', () => {
      setTimeout(() => { alert('fixture alert'); document.getElementById('dialog-state').textContent = 'Dialog: accepted'; }, 0);
    });
  </script>
</body></html>`;

const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(page(request.url === "/next"));
});

server.listen(0, "127.0.0.1", () => {
  void (async () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server address unavailable");
    await app.whenReady();
    const browserWindow = new BrowserWindow({ width: 900, height: 700, show: true, title: "Owned Cua Browser Fixture" });
    browserWindow.on("closed", () => app.quit());
    await browserWindow.loadURL(`http://127.0.0.1:${address.port}/`);
    process.stdout.write(`${JSON.stringify({ status: "ready", pid: process.pid, appPort: address.port, cdpPort })}\n`);
  })();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => server.close());
