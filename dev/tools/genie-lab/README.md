# Floating Genie lab

An isolated Electron shell for trying three companion sizes, screen-edge
docking and the Nautilo / AI Elements Persona visuals. The surface lives in
Workbench so it can be connected to the existing runtime without a second UI.

```sh
bun run --cwd dev/tools/genie-lab start
```

Drag the orb or header. Release near an edge to snap; right-click
anywhere for explicit docking, visual and simulated-state controls. With the lab
focused, use **Cmd/Ctrl+1–3** for orb, compact panel and full chat; **Shift+F10** opens
the same native menu. The bubble has no persistent text.
The menu is also available in the macOS application menu. The visible expand
button on the bubble opens chat directly; chat's collapse button hides history
in the compact panel. Choose Tiny orb from the menu to return to the orb. Keyboard focus follows the view change.

This is a **shell preview**. Tapping the microphone previews an animation. It
never requests microphone permission or sends drafts. Expanded chat keeps local
drafts in memory across view switches; quit or reload discards them. Only view,
visual and placement are persisted in the separate `Nautilo Genie Lab` app-data
directory. No server, database, credentials, Relay or installed Nautilo profile
is used. Provider integration and Computer Use belong to later qualification.

The build downloads the official Persona Opal animation once and verifies its
SHA-256; Rive WASM is copied from the lockfile-pinned runtime. Runtime network
access is denied. See [asset provenance](NOTICE.md). These experimental assets
are not part of Desktop's production packaging.

```sh
bun run --cwd dev/tools/genie-lab test
bun run --cwd dev/tools/genie-lab typecheck
node dev/tools/genie-lab/smoke.ts
```

The smoke check opens only the lab app, verifies actual Electron bounds and shared
state, and quits it. It does not start a server or access a microphone. Run it
with any manually launched lab closed so the single-instance lock remains intact.
