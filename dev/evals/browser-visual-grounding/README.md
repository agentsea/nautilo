# Browser visual-grounding corpus

This corpus pairs the exact accessibility observation used by Nautilo's
`browser_snapshot` path with the PNG used by `browser_screenshot`. Each case is
captured from one active embedded Browser view with no intervening action.

The capturer uses the production `agent-browser` argument builders and parser.
It records a case only when the URL, accessibility snapshot, refs, and viewport
remain unchanged across the snapshot/screenshot pair. It never records the CDP
URL or other local browser capability.

## Capture a case

1. Open the target state in the worktree's integrated Browser and stop
   interacting with it.
2. Run:

   ```sh
   bun dev/evals/browser-visual-grounding/capture.ts \
     --id gym-example \
     --description "AgentSea Gym example initial state" \
     --profile "/absolute/path/to/the/Desktop/profile"
   ```

Case IDs are immutable lowercase slugs. A capture refuses to overwrite an
existing case; use a new ID for a materially different state.

Each case contains:

- `snapshot.txt` — the exact normalized accessibility text presented by the
  embedded Browser relay;
- `screenshot.png` — the exact rendered PNG used for visual reasoning;
- `case.json` — URL, refs, viewport/coordinate mapping, capture timing,
  toolchain version, and artifact hashes.

Run `bun test dev/evals/browser-visual-grounding` to validate the corpus.

## Run the single-step Jev baseline

`tasks.json` defines one reviewed next-action task and oracle for every capture.
The runner binds the captured observation exactly as the live browser decision
episode does, uses production candidate generation, builds the production
Choice request, and runs the production Jev screening/choice loop. It never
executes the selected browser action, so every case starts from its immutable
capture.

Prepare and inspect all deterministic requests without calling Jev:

```sh
bun dev/evals/browser-visual-grounding/run-baseline.ts
```

Call Jev and score all eight selections:

```sh
OPENROUTER_API_KEY=... \
  bun dev/evals/browser-visual-grounding/run-baseline.ts --live
```

Use `--case room6-checkout` for one case or `--model <decision-model-id>` for a
different catalogued Choice model. Each run writes a mode-600 JSON report under
the ignored `.results/` directory and refreshes `.results/latest.json`. The
report includes the production Choice request, the exact provider URL and JSON
body sent on every Jev call (including screening calls), the successful raw
provider response with its returned selection and metadata, the selected
production candidate, the reviewed oracle, and the pass/fail verdict. The
Authorization header is intentionally never recorded. Screenshot paths are
included for semi-manual review. Provider usage and cost stay in that report;
the standalone runner does not require or write an instance database.
