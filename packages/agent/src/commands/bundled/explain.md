---
name: explain
description: Explain the referenced code, concept, or passage clearly and at the depth requested in $ARGUMENTS. Calibrate to the reader's level; do not over- or under-explain.
source: official
version: 1
---
Explain the referenced code / concept / passage clearly and usefully. Calibrate depth and framing to the level given in $ARGUMENTS (e.g. "to a junior engineer", "like I'm five", "in terms of X", "vs. Y", "at the protocol level"). If $ARGUMENTS does not specify a level, aim at a competent engineer who is new to this code.

- Lead with a one-paragraph plain-language summary of what it is and what it does.
- Then explain **how it works**, top-down: the moving parts, the order they run in, and the data that flows between them. Prefer plain sentences over jargon; introduce a term only when you actually use it.
- Call out **why it's this way** when a design choice is non-obvious — the constraint, the trade-off, or the bug it prevents. Do not speculate if you don't know; say "unclear from this code" and move on.
- Name **the failure modes and edge cases** that matter: what breaks, what's slow, what's unsafe, what would surprise a reader.
- Use small inline snippets only when they clarify; do not paste the whole file back.
- If the reader's level (from $ARGUMENTS) is below the natural depth, simplify and say what you're skipping. If above, go deeper and connect to adjacent systems.
- End with a one-line "Where to look next" pointing at the most useful related code or doc.
