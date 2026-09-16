function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function padDiagKey(label: string, width: number): string {
  return label.length >= width ? label.slice(0, width) : label + " ".repeat(width - label.length);
}

function diagLine(label: string, value: string, width = 24): string {
  return `${padDiagKey(label, width)} = ${value}`;
}

/**
 * D171 — HTML for the case where the API server is up but the Workbench SPA
 * static tree is not mounted at `/`. Pure helper (no Fastify).
 */
export function renderWorkbenchNotServedPage(input: {
  workbenchDistEnv: string | undefined;
  indexHtmlExists: boolean;
  serverVersion: string;
  instanceId: string;
}): string {
  const distEnvHtml =
    input.workbenchDistEnv === undefined
      ? escapeHtml("<unset>")
      : escapeHtml(input.workbenchDistEnv);
  const indexState = input.indexHtmlExists ? "present" : "missing";
  const serverVersion = escapeHtml(input.serverVersion);
  const instanceId = escapeHtml(input.instanceId);

  const diagnostics = [
    diagLine("NAUTILO_WORKBENCH_DIST", distEnvHtml),
    diagLine("dist/index.html", escapeHtml(indexState)),
    diagLine("server version", serverVersion),
    diagLine("instance id", instanceId),
  ].join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Nautilo</title>
    <style>
      html,
      body {
        height: 100%;
        margin: 0;
        font-family: Inter, system-ui, sans-serif;
        background: #0f1420;
        color: #f4f6fb;
      }
      .shell {
        min-height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 32px 20px;
        box-sizing: border-box;
      }
      .card {
        max-width: 440px;
        width: 100%;
        text-align: center;
      }
      .wordmark {
        margin-bottom: 28px;
        display: flex;
        justify-content: center;
      }
      .wordmark svg {
        display: block;
      }
      h1 {
        font-size: 1.25rem;
        font-weight: 600;
        margin: 0 0 10px;
      }
      .sub {
        font-size: 0.95rem;
        line-height: 1.45;
        color: rgba(244, 246, 251, 0.72);
        margin: 0 0 24px;
      }
      h2 {
        font-size: 1rem;
        font-weight: 600;
        margin: 20px 0 10px;
        text-align: left;
      }
      ul {
        margin: 0 0 8px;
        padding-left: 1.2rem;
        text-align: left;
        color: rgba(244, 246, 251, 0.88);
        font-size: 0.95rem;
        line-height: 1.45;
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 0.88em;
      }
      .operator {
        text-align: left;
        font-size: 0.95rem;
        line-height: 1.45;
        color: rgba(244, 246, 251, 0.82);
      }
      .operator pre.codeblock {
        margin: 10px 0 12px;
        padding: 12px 14px;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(244, 246, 251, 0.12);
        overflow-x: auto;
        text-align: left;
      }
      details {
        margin-top: 20px;
        text-align: left;
        color: rgba(244, 246, 251, 0.88);
        font-size: 0.92rem;
      }
      details summary {
        cursor: pointer;
        font-weight: 600;
      }
      details pre {
        margin: 10px 0 0;
        padding: 12px 14px;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(244, 246, 251, 0.12);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 0.82rem;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-all;
        color: rgba(244, 246, 251, 0.88);
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="card">
        <div class="wordmark" aria-label="Nautilo">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 132 28" width="132" height="28" role="img">
            <text x="0" y="21" fill="#ffffff" font-size="20" font-weight="700" font-family="Inter, system-ui, sans-serif" letter-spacing="0.04em">Nautilo</text>
          </svg>
        </div>
        <h1>The Workbench isn&apos;t being served from this URL</h1>
        <p class="sub">The Nautilo server is running, but the Workbench (the UI) isn&apos;t served from this address.</p>
        <h2>What to do</h2>
        <ul>
          <li>Open the Nautilo desktop app.</li>
          <li>Or, in a terminal: <code>bun run dev-stack --electron</code></li>
        </ul>
        <h2>If you&apos;re an operator</h2>
        <p class="operator">The SPA static files weren&apos;t found at <code>NAUTILO_WORKBENCH_DIST</code>. Build them with:</p>
        <pre class="codeblock"><code>bun run build:workbench</code></pre>
        <p class="operator">Then restart the server.</p>
        <details>
          <summary>Diagnostics</summary>
          <pre>${diagnostics}</pre>
        </details>
      </div>
    </div>
  </body>
</html>`;
}
