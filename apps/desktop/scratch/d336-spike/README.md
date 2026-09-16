# D336 Embedded Browser Spike

Throwaway harness for Stack 108 / D336 Phase 0.

## Run

From the repo root:

```bash
bun apps/desktop/scratch/d336-spike/run.ts
```

Then, from the repo root in another terminal:

```bash
agent-browser --config apps/desktop/scratch/d336-spike/agent-browser.json \
  --provider nautilo-spike snapshot -i
```

Useful env vars:

- `D336_SPIKE_PORT` (default `47736`)
- `D336_SPIKE_TOKEN` (default `d336-spike-token`)
- `D336_SPIKE_URL` (default `https://docs.google.com`)

Shortcuts in the Electron window:

- `Cmd/Ctrl+Shift+H` toggles the `WebContentsView` visible/hidden
- `Cmd/Ctrl+Shift+F` shows/focuses the view

## Scope

No Nautilo server, Workbench, DB, or agent. The agent role is played by
agent-browser CLI commands. This harness only tests:

- `WebContentsView` + `persist:google`-style session persistence
- in-process `webContents.debugger.attach`
- a page-scoped CDP WebSocket shim
- agent-browser `browser.provider` plugin with `directPage:true`
