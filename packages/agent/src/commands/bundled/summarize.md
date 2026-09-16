---
name: summarize
description: Summarize a referenced thread, document, or passage into a tight, faithful digest. Pass an optional focus or anchor in $ARGUMENTS to steer what to extract.
source: official
version: 1
---
Summarize the referenced content faithfully and concisely. Lead with the most important points; do not invent facts or smuggle in opinions that are not in the source.

- Start with a 1–2 sentence overview of what the content is and why it matters.
- Follow with 3–7 bullet points capturing the load-bearing claims, decisions, or events.
- Preserve key names, numbers, and quotes verbatim where they matter.
- If $ARGUMENTS is provided, weight the summary toward that focus or anchor (a person, a topic, a question, a time range). Ignore content outside the focus only if it is clearly irrelevant — otherwise include it as brief context.
- End with a one-line "Open questions / gaps" list of anything ambiguous, unresolved, or missing from the source.
- Match the source's language unless asked otherwise.
