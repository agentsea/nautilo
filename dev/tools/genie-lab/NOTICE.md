# Visual provenance

- Nautilo OrbCanvas: reused from `packages/genie-customization-ui` under the
  repository's license; no copied fork of the shader.
- Persona Opal adapter: follows Vercel AI Elements' public Persona state-machine
  mapping. Source: https://github.com/vercel/ai-elements/blob/main/packages/elements/src/persona.tsx
  Copyright 2023 Vercel, Inc.; Apache License 2.0:
  https://github.com/vercel/ai-elements/blob/main/LICENSE
  The lab uses only Opal, removes theme/view-model handling for other variants,
  loads local assets and exposes no remote-source option.
- Opal animation: the `orb-1.2.riv` asset linked by that official component,
  10,178 bytes, SHA-256
  `ff2e885d4f065bbfd9b855b1a7aeaecb771c1047d9ef196ba910ba114aac06f8`.
  Source URL is recorded in `build.ts`. The animation is downloaded into ignored
  build output for this evaluation; separate redistribution terms for the hosted
  artwork still need verification before production packaging.
- `@rive-app/react-webgl2` 4.34.3 / `@rive-app/webgl2` 2.42.2: MIT; WASM and JS
  resolve from the workspace lockfile. See the installed packages' licenses.

The Persona code is provided under the Apache License, Version 2.0, available at
https://www.apache.org/licenses/LICENSE-2.0. Unless required by applicable law or
agreed to in writing, it is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES
OR CONDITIONS OF ANY KIND, either express or implied.
