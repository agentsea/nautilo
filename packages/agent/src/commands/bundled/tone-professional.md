---
name: tone-professional
description: Rewrite the referenced text in a professional tone. $ARGUMENTS is the text to rewrite, or a reference to it. Preserve meaning; change register.
source: official
version: 1
---
Rewrite the text provided in $ARGUMENTS in a professional register. Keep every claim, name, number, and instruction identical in meaning — change only tone and phrasing.

Calibration:
- **Clear over formal.** "Professional" does not mean stiff, verbose, or bureaucratic. It means calm, precise, and respectful. A reader should feel served, not managed.
- **Active voice, plain verbs.** Prefer "we will ship the fix on Tuesday" over "the fix will be shipped on Tuesday." Prefer "I'm sorry this broke your flow" over "we regret any inconvenience caused."
- **Cut filler and hedges.** Remove "just", "very", "really", "I think", "hopefully", "basically", and other words that soften without adding meaning. Keep a hedge only when the claim genuinely is uncertain.
- **No corporate clichés.** Avoid "circle back", "leverage", "synergy", "deep dive", "move the needle", "reach out", "per my last email", and similar.
- **Direct about problems.** Name the issue, the impact, and the next step. Do not bury a problem in soft language; do not inflate a minor issue into a crisis.
- **Match the relationship.** A reply to a customer outage reads differently from an internal status update. If $ARGUMENTS implies an audience (customer / teammate / executive / public), calibrate to it. If unclear, aim at a competent internal colleague.
- **Preserve the original's structure and length unless asked otherwise.** Do not pad a one-line reply into a paragraph, and do not compress a careful paragraph into a one-liner.

If $ARGUMENTS references something the agent must fetch (a thread, a file, a quoted passage) rather than containing the text itself, fetch it first, then rewrite. Output only the rewritten text, unless a brief one-line framing ("Here's a more professional version:") is conventional in this channel.
