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

## Run Approach A: Sol screenshot → visual snapshot → Jev

The visual baseline deliberately hides the DOM snapshot from Sol. Sol receives
only the captured PNG and produces a task-independent JSON inventory of visible
text and actionable targets with image-pixel centers. The harness renders that
inventory into snapshot-like text, adds executable `browser_mouse` candidates,
and sends it through the same production Jev request and screening path as the
DOM baseline.

Every visual decision also includes two stable ordinary actions:

- `scroll_up` → `browser_scroll {direction:"up"}`
- `scroll_down` → `browser_scroll {direction:"down"}`

Both require a fresh screenshot before acting on newly visible content.

Validate the eight tasks and reviewed screenshot-coordinate oracles without
calling either model:

```sh
bun dev/evals/browser-visual-grounding/run-visual-baseline.ts
```

Run Sol and then Jev for all captures:

```sh
OPENAI_API_KEY=... OPENROUTER_API_KEY=... \
  bun dev/evals/browser-visual-grounding/run-visual-baseline.ts --live
```

Use `--case room15-second-row` for one case, `--vision-model <id>` to compare a
different vision model, or `--decision-model <id>` to compare a different
Choice model. Reports are written as mode-600 ignored files and
`.results/visual-latest.json` always points to the latest visual run.

For a deliberate evaluation of an OpenRouter model that is not in Nautilo's
signed product catalogue, use its provider slug without the `openrouter:`
prefix. This eval-only path keeps an explicit 8K output ceiling and 120-second
per-request timeout, and does not alter or bypass product-runtime catalogue
enforcement:

```sh
OPENROUTER_API_KEY=... \
  bun dev/evals/browser-visual-grounding/run-visual-baseline.ts --live \
  --direct-openrouter-model qwen/qwen3.8-max-0902
```

The runner requests schema-bounded normalized 0–1000 point coordinates from
Qwen3-VL, and from Qwen3.8 Flash in task-directed mode, then deterministically
converts them into screenshot pixels before constructing browser operations.

Use `--task-directed` to test the low-latency variant. It supplies the current
plan goal to the visual model, requests only the direct target plus genuinely
ambiguous alternatives, caps the result at five targets and 768 output tokens,
and requests the lowest supported reasoning mode from direct OpenRouter models
(`low` where reasoning is mandatory). Reports record vision, Jev, and total
latency separately for every case:

```sh
OPENROUTER_API_KEY=... \
  bun dev/evals/browser-visual-grounding/run-visual-baseline.ts --live \
  --task-directed \
  --direct-openrouter-model qwen/qwen3-vl-235b-a22b-instruct
```

The automatic oracle checks whether Jev's selected image coordinate falls
inside the reviewed target region. The report retains the screenshot path,
vision-model prompt and raw/parsed grounding, rendered visual snapshot, complete Jev
request/response, candidate selected, and verdict for semi-manual inspection.
For tasks that ultimately require typing, this first experiment scores the
correct visual focus as the next action; deterministic focused-text execution
is intentionally a later runtime step, not claimed by this baseline.

## Run local classic-vision approaches

[`CLASSIC-VISION.md`](CLASSIC-VISION.md) records the recommended model-free
pipeline and its limits. The accompanying harness compares a macOS-native Apple
Vision backend with a portable Tesseract plus Sharp LAB-edge backend. Both
produce the same snapshot and image-coordinate candidate contract and can feed
the same production Jev choice loop:

```sh
bun dev/evals/browser-visual-grounding/run-classic-baseline.ts --backend all

OPENROUTER_API_KEY=... \
  bun dev/evals/browser-visual-grounding/run-classic-baseline.ts \
  --backend all --live
```
