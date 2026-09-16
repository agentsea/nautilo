---
description: Nautilo project orientation for AI assistants
globs:
  - "**/*"
---

# Nautilo Project Rules

Read `README.ai` at the repo root before doing anything substantive.
It maps the codebase, lists common mistakes, and points to the playbook.

## Critical Rules

1. **Plan before building.** Use the public issue forms and the specification
   path in `CONTRIBUTING.md` for non-trivial work. Check the curated problems at
   `https://nautilo.ai/community/problems`. Don't freeball.

2. **Use public sources.** Read `DOCS.md`, relevant versioned repository docs,
   and `https://nautilo.ai/docs/build`. Do not assume access to a private
   sibling repository, local maintainer paths, or unpublished planning.

3. **SolidJS, not React.** The TUI uses OpenTUI + SolidJS. Props are reactive
   only when accessed through the props object — never capture with `const t = props.x`.

4. **Config in nautilo.config.ts, secrets in .env.** Period.

5. **TTS runs TUI-side.** Audio plays where the speakers are. The server
   handles text only.

6. **ElevenLabs eleven_v3 only.** Never use turbo or multilingual models.

7. **Tell the user the answer in the GUI.** Exact menu paths, exact settings.
   No silent failures.
