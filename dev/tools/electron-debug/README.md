# Nautilo Electron Debug MCP

Small MCP server for inspecting the Nautilo Electron renderer over the Chrome
DevTools Protocol.

## Panel Diagnostics

D242 added two convenience tools for right-side Agent panel load debugging:

- `electron_enable_panel_diagnostics`
  - Adds `panelDiagnostics=1` to the current Workbench URL.
  - Optionally adds `reactScan=1` for builds that include a React Scan hook.
  - Reloads the renderer and clears the MCP console buffer by default.
- `electron_collect_panel_diagnostics`
  - Returns current URL/title, whether `Loading profile` is visible, a text
    sample from the UI, D242 console timing logs, and relevant resource timing
    entries.

Typical flow:

```text
electron_enable_panel_diagnostics({ clearLogs: true })
# reproduce or wait for the panel load
electron_collect_panel_diagnostics({ last: 120 })
```

The tools are wrappers around existing `electron_eval` and
`electron_console_logs` behavior. They do not install React Scan or change
Workbench runtime behavior by themselves; the app must expose any optional
diagnostic hooks it wants to use.
