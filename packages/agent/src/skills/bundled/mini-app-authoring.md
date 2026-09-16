---
name: mini-app-authoring
description: Rules for creating and editing installed mini-app source via the mini_app tool — dependency-free V1, strict app.json, layout, createActions/templates, iframe bridge, and validate-after-write.
requiresTools: [mini_app]
source: official
version: 1
---
# Mini-App Authoring — Skill

## Use `mini_app`, Not `file`

Installed mini-app source lives under the server apps root with strict manifest validation, source hashing, runtime build, and deployed agent-tool registration. The `file` tool cannot create apps or safely batch-edit app source. Always use `mini_app` for list/inspect/read/create/batch-write/validate.

## V1 Is Dependency-Free

Do not add npm/Bun dependencies. Reject or omit non-empty `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies` in `package.json`. Prefer browser-native APIs only.

## Required Layout

Keep apps small and predictable:

```text
app.json
index.html
main.ts
styles.css
templates/<blank-document>.html
src/<helpers>.ts
```

Always include a strict `app.json` whose `id` matches the app folder id. Unknown manifest keys are rejected — follow maintained first-party apps under `packages/first-party-apps/` and the manifest schema in `@nautilo/types` for capability and entry fields.

## Manifest Essentials

- Declare runtime entry/html/style paths.
- Use `createActions` / `templates/` for app-created documents.
- Add `agent.tools` only when the app needs agent-side document operations; otherwise omit `agent`.
- Declare document/state capabilities the UI actually uses.

## Iframe Bridge

UI code runs in a sandboxed iframe. Use `window.nautiloApp` for document read/write and app state — not `file`, not `window.parent`.

Typical loop:

```js
const doc = await window.nautiloApp.document.read();
// render UI …
await window.nautiloApp.document.write(serializedContent);
```

Check bridge availability before relying on it and surface a clear in-app error when missing.

## Authoring Workflow

1. `inspect_app` / `read_source` before editing an existing app.
2. `create_app` or `apply_source_batch` with bounded payloads.
3. `validate_app` after every write (runtime build + agent tools when declared).
4. Report validation errors clearly; do not weaken manifest rules to “make it pass”.

## Paint-Like / Canvas Apps

For drawing or visual editors: use `<canvas>` and browser-native serialization (HTML container or data URLs). No external image libraries. Include a create action for a blank canvas document template.
