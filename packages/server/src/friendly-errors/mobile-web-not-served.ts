/** D515 — bounded browser diagnostic when the optional Mobile Web export cannot mount. */

export type MobileWebNotServedReason =
  | "not-configured"
  | "index-missing"
  | "invalid-export"
  | "inspection-failed";

const OPERATOR_DETAIL: Readonly<Record<MobileWebNotServedReason, string>> = {
  "not-configured": "This server has not been configured to serve the Mobile Web export.",
  "index-missing": "The configured Mobile Web export is incomplete.",
  "invalid-export": "The configured Mobile Web export did not pass its static-asset validation.",
  "inspection-failed": "The server could not inspect the configured Mobile Web export.",
};

/**
 * Intentionally static HTML: do not render configured filesystem paths, asset
 * names, exception messages, or request values into a public diagnostic page.
 */
export function renderMobileWebNotServedPage(reason: MobileWebNotServedReason): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mobile Web unavailable — Nautilo</title>
    <style>
      html, body { height: 100%; margin: 0; font-family: Inter, system-ui, sans-serif; background: #0f1420; color: #f4f6fb; }
      main { box-sizing: border-box; min-height: 100%; display: flex; align-items: center; justify-content: center; padding: 32px 20px; }
      article { max-width: 440px; width: 100%; }
      h1 { font-size: 1.25rem; margin: 0 0 10px; }
      p, li { color: rgba(244, 246, 251, 0.78); line-height: 1.5; }
      a { display: inline-block; margin-top: 8px; border-radius: 6px; background: #7c5cff; color: white; padding: 10px 14px; text-decoration: none; font-weight: 600; }
      details { margin-top: 28px; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    </style>
  </head>
  <body>
    <main>
      <article>
        <h1>Mobile Web isn&apos;t available on this server</h1>
        <p>Use Full Workbench to continue with Nautilo.</p>
        <a href="/?nautilo-interface=workbench">Open Full Workbench</a>
        <details>
          <summary>Operator recovery</summary>
          <p>${OPERATOR_DETAIL[reason]}</p>
          <ol>
            <li>Build the Mobile Web export: <code>bun run --cwd apps/mobile export:web</code></li>
            <li>Set <code>NAUTILO_MOBILE_WEB_DIST</code> to that export directory.</li>
            <li>Restart the Nautilo server.</li>
          </ol>
        </details>
      </article>
    </main>
  </body>
</html>`;
}
