---
name: interactive-artifact-authoring
description: Hard-won rules for authoring interactive HTML artifacts with nwState (get/set/emit/ping) and grading via read_artifact_events. Covers the three-channel model, emit-vs-ping notification semantics, form anti-patterns, bridge diagnostics, rich payload shape, and patch hygiene.
requiresTools: [file, read_artifact_events]
source: official
version: 2
---
# Interactive Artifact Authoring — Skill

## The Three-Channel Model

Keep these strictly separate:

| Channel | Tool | Purpose |
|---|---|---|
| **Artifact bytes** | `file.write` / block tools | Structure, content, labels |
| **UI state** | `window.nwState.get/set` | Draft answers, toggles, selections — reload-safe |
| **Agent notifications** | `window.nwState.emit` / `window.nwState.ping` | Milestone events — quiz submitted, form done, user stuck |

Never conflate a checkbox toggle (channel 2) with a paragraph rewrite (channel 1). Never assume the notification channel works just because `get/set` work.

---

## Notify Channel: `emit` vs `ping`

Channel 3 has **two** methods. They enqueue the same event with the same payload; they differ only in agent timing:

| Method | What it does | Use when |
|---|---|---|
| `await nwState.emit(topic, payload)` | Enqueues the event for the agent's **next turn**. Does not wake an idle agent. | The agent is already in the loop, or the user will return to chat / say "grade it" on their own. |
| `await nwState.ping(topic, payload)` | Enqueues the same event **and wakes an idle agent now** (M153). | A user action should pull the agent in immediately — e.g. "Submit" on a quiz, "I'm done", "I'm stuck". This is the common graded-artifact case. |

Both resolve once the host accepts the HTTP round-trip; both require a non-empty string `topic` and a JSON-serializable `payload`. Reach for `ping` whenever the artifact's whole point is "do this, then the agent reacts" — that's most graded interactions. Use `emit` for passive milestones you don't need acted on until the next turn.

The agent drains either one the same way: `read_artifact_events`.

---

## The Graded Interaction Loop

```
1. file.write → artifact exists in workspace
2. User interacts → nwState.set saves draft state
3. User submits → nwState.ping('exercise_completed', payload)   // wakes the agent now
4. Backend queues the event and wakes the idle agent
5. Agent calls read_artifact_events({ path: 'artifacts/foo.html' })
6. Agent grades from the returned payload
```

Use `ping` on submit so grading starts immediately — the user shouldn't have to return to chat and ask. (Use `emit` instead only if you deliberately want to defer to the agent's next turn.)

`read_artifact_events` is **at-most-once** — events are consumed when read. Grade immediately on receipt.

---

## Anti-patterns

### ❌ Do NOT use native `<form>`

Sandboxed `srcdoc` iframes block form submission unless `allow-forms` is set. You will see:

```
Blocked form submission to '' because the form's frame is sandboxed and the 'allow-forms' permission is not set.
```

**Fix:** Use a plain `<div>` container and `type="button"` buttons with `addEventListener`:

```html
<div id="quizContainer" role="group">
  <!-- questions -->
  <button id="submitBtn" type="button">Submit</button>
</div>
<script>
  document.getElementById('submitBtn').addEventListener('click', submitQuiz);
</script>
```

### ❌ Do NOT use `window.parent.nwState`

Cross-origin security error in srcdoc iframes:

```
SecurityError: Blocked a frame with origin "null" from accessing a cross-origin frame.
```

The bridge is exposed directly on `window.nwState` inside the iframe. Use that.

### ❌ Do NOT assume the notify method exists because `get/set` work

Early platform builds injected only `get/set`, and `ping` is newer than `emit` (M153). Always check the specific method you call (`emit` or `ping`) before submitting — don't assume it's present.

### ❌ Do NOT emit/ping without awaiting

```js
// Bad — silent failure
window.nwState?.ping('exercise_completed', payload);
status.textContent = 'Submitted!';

// Good — await before showing success
await window.nwState.ping('exercise_completed', payload);
status.textContent = 'Submitted! Grading now…';
```

---

## Bridge Diagnostic (include in every graded artifact)

Check the method your artifact actually calls — `ping` for wake-now submits (below), or `emit` if you deliberately defer.

```js
if (
  !window.nwState ||
  typeof window.nwState.set !== 'function' ||
  typeof window.nwState.ping !== 'function'   // or .emit, whichever you call
) {
  status.textContent = 'Cannot submit: nwState bridge unavailable.';
  console.error('nwState bridge diagnostic', {
    hasNwState: Boolean(window.nwState),
    getType: typeof window.nwState?.get,
    setType: typeof window.nwState?.set,
    emitType: typeof window.nwState?.emit,
    pingType: typeof window.nwState?.ping
  });
  return;
}
```

---

## Rich Payload Shape (required for agent grading)

The agent must be able to grade **without reopening the UI**. Always include per-item results:

```js
{
  quiz: 'Quiz Name',
  submittedAt: new Date().toISOString(),
  score: 4,
  total: 5,
  results: [
    {
      number: 1,
      prompt: 'Full question text here',
      chosen: 'user answer',
      correct: 'correct answer',
      explanation: 'Why this is correct',
      ok: true
    },
    ...
  ]
}
```

**Never emit only `{ score, total }` or indexes.** The agent needs prompt text, chosen answer, correct answer, explanation, and ok flag per item to give useful feedback.

---

## Submit Function Template

```js
async function submitQuiz() {
  const payload = buildPayload(); // build rich results array

  if (!window.nwState ||
      typeof window.nwState.set !== 'function' ||
      typeof window.nwState.ping !== 'function') {
    status.textContent = 'Cannot submit: nwState bridge unavailable.';
    return;
  }

  await window.nwState.set('last_submission', payload);
  await window.nwState.ping('exercise_completed', payload); // wakes the agent to grade now
  status.textContent = 'Submitted! Grading now…';
}
document.getElementById('submitBtn').addEventListener('click', submitQuiz);
```

---

## Agent Grading Flow

When the user says "grade it" or "check my answers":

```js
read_artifact_events({ path: 'artifacts/your-artifact.html' })
```

Grade from the returned event payload. Do NOT try to reconstruct answers from artifact bytes.

---

## Explanation Lookup Anti-pattern

When questions shuffle, **never look up explanations by answer value**:

```js
// Bad — breaks when multiple questions share the same correct answer
const q = questions.find(q => q.answer === correct);
```

**Fix:** Store explanation as a `data-explanation` attribute on each DOM element, or key results by question index/id, not answer value.

---

## Patch Hygiene During Debugging

- Re-read the file after every applied patch before staging follow-up changes.
- Consolidate related JS/HTML changes into one patch rather than many overlapping small ones.
- Stale patch conflicts are noisy — the staleness guard is correct, not a bug.

---

## Scope

These rules apply to any graded interactive artifact: quizzes, flashcards, fill-in-the-blank, drag-to-match, code exercises. The loop is always the same — author, interact, notify (`ping` to wake now, `emit` to defer), grade.
