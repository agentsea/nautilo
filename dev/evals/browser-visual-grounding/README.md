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
