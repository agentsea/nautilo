# @nautilo/avatar

Rive state controller, emotion-to-animation mapping, and lip-sync amplitude/viseme helpers. No rendering — just the state machine that drives a Rive runtime.

## What will live here

- Emotion → animation state mapping.
- Lip-sync amplitude and viseme helpers for voice mode.
- State machine controller that apps wire to their platform-specific Rive `<canvas>` or React Native component.

## Who uses this

- `apps/mobile/` — Rive React Native component.
- `apps/workbench/` — Rive web component (Phase 2+).

## Status

Placeholder. Phase 2+ priority. The core product must be sticky before avatar polish matters.
