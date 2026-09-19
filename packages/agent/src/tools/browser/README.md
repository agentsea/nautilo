# Routine browser decisions

The embedded browser automatically selects an eligible catalogued Choice model
when its provider credential and account policy permit it. Catalog, credential,
and policy checks use the same runtime sources as other models. When no eligible
decision model is runnable, ordinary Genie browser control remains available. See
[catalog compatibility](../../config/model-catalog/README.md) for reader behavior.

## Local qualification

Use a disposable development instance with Desktop connected and the OpenRouter
key configured through its normal credential setup. Check the admin model
catalog for the Jev decision row and its availability. No decision-model
environment switch is needed. Start the isolated server normally:

```bash
bun run server:start --instance browser-review
```

For offline bundled-catalog qualification only, the fixture preload
`dev/fixtures/browser-decision/bundled-catalog.ts` disables remote refresh through
the existing runtime seam. It is not required for normal signed-catalog use and
does not publish a catalog. Stop the disposable server before changing a preload;
`server:start` adopts an already-running process.

Use the name of an existing disposable instance in place of `browser-review`.
Start the local fixture separately:

```bash
bun dev/fixtures/browser-decision/server.ts --port 9471
```

Open `http://127.0.0.1:9471/` in Desktop's internal browser and ask the Genie to
find the cheapest in-stock blue mug and report its detail-page SKU without buying
anything. Verify the result independently. To compare the ordinary loop, use a
disposable instance whose normal credential or account policy makes no eligible
Choice model runnable. Keep the same orchestrator model for that comparison. Also check
recovery after a page change and browser operation while Desktop is backgrounded.

These commands do not publish a catalog or enable the decision route for other instances.

## Delegation and recovery

A Genie delegates a routine segment with a singleton `browser_snapshot` call
whose optional `decisionPlan` contains the goal and optional named exact typing
values. Omit `actions` to discover click targets from fresh observations. Exact
role/name action templates remain available for narrower delegation. Reusable action
templates also support `press` (any key or combination accepted by the ordinary
tool), `hover`, `double_click`, `scroll_into_view`, `select`, `set_checked`,
`drag`, `scroll`, and navigation (`open`, `back`, `forward`, `reload`). Include
`click_observed` alongside them to retain fresh click discovery. The Genie supplies
exact keys and other arguments once; Jev chooses again after every observation.
Semantic targets, including both ends of a drag, resolve to fresh refs. Keyboard
input uses the focused page control and needs supporting state or a successful
focus action. Missing visual evidence still returns to the Genie for grounding.
Progress and success predicates are optional; omit them when
future page evidence is not yet known. The
server supplies the current page origin when `allowedOrigins` is omitted;
additional constraints default to none. Supplied HTTP(S) URLs are reduced to origins and
deduplicated; paths, queries and fragments need not be removed by the Genie. Harmless extra fields are ignored. Invalid semantic fields return
a visible error with field paths and the exact JSON Schema generated from the
accepting contract; no browser request is sent. For example, after inspecting a fixture:

```json
{
  "decisionPlan": {
    "goal": "Find the cheapest in-stock blue mug and open its detail page",
    "constraints": ["Only inspect products; do not buy anything"],
    "values": {"search query": "blue mug"}
  }
}
```

When known, supply meaningful page-specific progress evidence for routine stages. Existing
true predicates are baselined rather than counted as new progress. `url_equals`
with an exact `url` is the other supported predicate. The optional `success`
predicates are completion hints: their literal match results accompany the fresh
observation sent to Jev, without ending delegation or removing action candidates.
A match can describe typed text, suggestions or a pending operation rather than
a committed result. Jev assesses the whole delegated goal and continues supported
routine work, returning to the Genie when it appears complete or needs interpretation.
Unmatched hints do not prevent that handoff. The Genie independently verifies
completion and reports the result; Jev cannot declare the user's task complete.

For changing pages, the Genie can supply `{"kind":"click_observed"}` in
`actions` instead of enumerating every clickable label. Code generates one click
candidate per currently observed target, without a role whitelist. Exact
role/name click targets remain available for narrower delegation. Named values
are paired with fresh observed refs so Jev can match their purpose to a newly
discovered editable field. The runtime copies the selected text unchanged,
replacing the field content; exact typing templates can instead request append.
Goal and constraints guide Jev; they do not
prove a click is semantically safe. Normal tool admission still governs every
proposed action, including when the page exposes destructive controls.

The complete admitted candidate set comes from the latest structured snapshot.
Ambiguous exact role/name targets, indistinguishable local text choices, no matching target,
or a changed observed origin hand back immediately. There is no first-N truncation or invented text. Jev can
also select re-observation or deliberate deferral. With exact targets, new
result/detail links require a revised plan. With `click_observed`, new targets
become candidates automatically; Jev must defer when interpreting them exceeds
the delegated goal and constraints.

When the complete list exceeds the model's catalogued Choice capacity, Jev
screens groups in parallel using the same observation and goal. Each group
nominates one action or explicitly abstains. Further screening rounds run only
when the nominees still exceed capacity with the two control choices reserved.
One final Choice selects among the nominees, re-observation and Genie handback;
screening never executes an action. This is model-guided elimination for this
decision, so an incorrect nomination can discard the right action. The full
candidate set remains local, and a fresh observation rebuilds it. Existing
progress checks and supervision handle mistakes. Every provider request is
accounted separately; the action receipt reports aggregate usage, call count
and screening rounds. A failed round cancels and awaits its siblings before
entering recovery.

The branch runs before `pre_model`. Every chosen action is one ordinary proposed
AI tool call through model-output, projection, content-access, approval and tool
admission. After every action it obtains a new snapshot. It never writes an
approved call directly, runs a nested executor, or batches dependent mutations.
The existing recursion budget, cancellation and no-progress breaker remain in
force. Graph superstep metrics count the branch; Choice usage is recorded once per provider request by
the existing usage recorder.

Only goal, constraints, complete AX text and descriptions of the candidate
operations go to Choice. Confirmed routine action descriptions and outcome
status from the current delegation are reused from graph history, so the model
can avoid repeating ineffective actions; raw tool results and typing values
are not added to this history. Keyboard combinations and native selection values are included in candidate descriptions
so Choice can distinguish them. Fixed typing values, navigation URLs, URL predicates, origin lists and
private session/observation bindings stay local unless the same text is itself
part of the supplied goal or observed page. The live Full-encryption policy must
explicitly permit ordinary provider egress. A missing policy resolver fails
closed. Existing whole-channel checkpoint protection also covers decision state.

## Freshness and recovery

Electron owns a serialized browser queue and one latest observation. Each bound
browser mutation consumes its observation ID. Under the same queue, Electron rereads
the complete AX tree, ref map and URL, compares them, then executes through the
existing agent-browser argv adapter. Other browser mutations invalidate the old
observation. Session and cancellation checks run before and after awaited work.
The supported relay lifecycle drains admitted work before replacing its handler.

Embedded-browser pointer and key input first focuses the exact guest element
inside Workbench, then uses its CDP connection. Shim input is serialized across
embedded and research targets so their focus-and-send operations cannot
overtake one another. This changes focus within Nautilo without bringing its
OS window forward; it does not prevent a concurrent Human focus change.
While a browser-control shim is alive, its guest and embedding Workbench keep
rendering in the background. Shared hosts restore their previous throttling
setting after the last shim closes. Ordinary viewport PNG capture uses Electron's
native capture lifetime so an occluded guest can produce a frame without native
window activation. A cold embedded guest first requests its host compositor frame;
that host image is discarded without encoding or publication. Clipped,
alternate-format and child-session captures retain
their CDP behavior. An empty or failed capture returns an error; a minimized or
locked desktop is not guaranteed to have a usable surface.

Jev receives textual observations, not screenshot pixels. When the next target
requires visual information, its handback choice asks the Genie to inspect a
`browser_screenshot` and use the existing `browser_mouse` coordinate action.
Image-input support makes that tool available; it does not certify a model's
text-reading or target-location accuracy. Verify the result from fresh state.

This establishes AX/URL equivalence, not absolute DOM identity: page JavaScript
or a Human can still change a target between comparison and execution, including
changes that return to identical observable evidence. Allowed origins constrain
decisions on observed state; they are not a pre-effect navigation firewall.
Existing tool authority governs each proposed action.

`NAUTILO_BROWSER_DECISION_INTERVENTION_LIMIT` is a positive integer, initially
`2`. It is captured at the initial handoff for the turn, so a live config change
does not silently rewrite checkpointed recovery policy. A known stale observation
or recoverable Choice failure counts once and obtains fresh evidence. An
unchanged AX/URL/ref observation counts once; changed material permits another
choice without clearing earlier errors, even while a declared milestone is still
pending. Milestones provide positive evidence rather than exhaustively naming
every intermediate state. Continually changing page content can
therefore continue until Genie handoff, cancellation or the existing graph
budget; this detector alone does not establish goal progress or bound such loops. Tool success, confidence,
or a new observation UUID alone never resets the streak.

At the intervention threshold, the Genie receives the reason and count. A revised
plan or changed material evidence may begin another recovery episode while
preserving the prior count; only a newly verified progress predicate clears it.
An unchanged handback is refused, including after ordinary multi-tool work.
Unknown failures, lost authority, cancellation and uncertain mutation results
require immediate Genie inspection. A sent mutation whose receipt is lost uses
the existing desktop-automation outcome-unknown path and must not be replayed.
Uncertain-outcome errors retain the failed operation and underlying browser or
relay diagnostic (including an available browser cause code) so the Genie can
inspect fresh state and choose a repair. This also applies to background task
runs; receipt loss is not treated as a known pre-execution relay failure.
After input, the next snapshot first checks rendered page readiness and the
focused control's busy/autocomplete state. A short combobox grace allows delayed
responses to begin; it is a settling heuristic, not task verification. Existing
cancellation, operation timeout and fresh pre-action comparison still apply.
Choice history distinguishes stale proposals rejected before input from failed
interactions. The decision model can reconsider the same intent using fresh
candidates without treating an unexecuted proposal as an uncertain effect.
For similar pickers that reuse ambiguous labels, the Genie can delegate typing
and selection for one semantic target, verify it, then delegate the next with
only the needed values. This uses ordinary plan handoffs rather than a new
workflow mechanism or a fixed one-field limit.
