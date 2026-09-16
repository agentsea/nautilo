# D501 Phase 0 dependency qualification

This ledger records reproducible evidence for the editing candidates and the
locked platform-specific decision. Android/iOS Markdown and iOS Writer evidence
must pass their applicable isolated matrices; Android Writer editing is outside
D501 after the decision recorded below. The D468 notification worktree, Metro
process, builds, and shared simulators are outside this qualification's scope.

## 0.2 — `@expensify/react-native-live-markdown`

Status: **blocked after preferred-control rejection and fallback replay**.

The candidate builds and its ordinary editing behavior works on both platforms,
but it does not satisfy the required long-line responsiveness acceptance. An
8,000-character first line in the 16,000-character fixture caused Android's
system ANR dialog before eventually rendering. D501 therefore replayed the
issue's already-authorized native `TextInput` fallback for Markdown source
editing. The fallback keeps every Markdown character visible and canonical and
delegates cursor, selection, IME, and paste to the platform control; it does not
add a custom cursor/selection engine. It passes the long-line row that rejected
the preferred package, but Android's React Native `TextInput` does not honor the
native Ctrl-Z replay after paste. Task 0.2 therefore remains open rather than
quietly weakening its undo acceptance. The rejected package has been removed.

### Version intersection

- Nautilo mobile: Expo SDK `57.0.11` (updated from `57.0.10` during the Writer
  replacement gate), React Native `0.86.2`, React `19.2.5`, New Architecture
  enabled.
- Candidate: `@expensify/react-native-live-markdown` `0.1.335` (exact pin).
- Upstream's compatibility table supports React Native 0.86 from `0.1.331` and
  requires `react-native-worklets` `0.10.2+` from `0.1.333`.
- Expo SDK 57 currently recommends `react-native-worklets` `0.10.1`. There is no
  upstream-supported live-Markdown release for the exact Expo-recommended
  worklets version: `0.1.331–0.1.332` reject worklets 0.10.x, while `0.1.333+`
  requires 0.10.2+. Qualification therefore uses the smallest candidate-supported
  patch, `react-native-worklets` `0.10.2`, and must prove it in both native builds.

### Parser and dependency boundary

The built-in `parseExpensiMark` path is not suitable for Nautilo:

- it hard-stops parsing above 4,000 UTF-16 code units;
- it requires `expensify-common` and `html-entities@2.5.3`, including an upstream
  patch that marks `html-entities` as a worklet;
- Bun installs the candidate's mandatory `expensify-common` peer, whose dependency
  graph contains React/React DOM 16 next to Nautilo's React/React DOM 19.

Nautilo instead exercises the package's documented custom worklet-parser API in
`src/features/artifact-editing/markdown-ranges.ts`. The parser only emits visual
ranges. It never transforms the source string, owns selection, or changes the
canonical artifact value. Live bundling proved the package root eagerly evaluates
the exported default parser even when only `MarkdownTextInput` is imported. The
upstream-required exact `html-entities@2.5.3` worklet patch is therefore mandatory;
without it both platforms fail before the route can export its component. Bun also
installs `expensify-common` as the candidate's mandatory peer. Native bundle/build
evidence must determine whether that packaging defect is acceptable or requires
rejecting or locally patching the candidate.

### Reproducible harness

Route: `/(onboarding)/qualification/live-markdown` (the onboarding group keeps
the dependency harness reachable without borrowing or fabricating an auth
session; the group is omitted from the public deep link).

The route contains Unicode/IME, empty, 3,900-character boundary, and 16,000-
character stress fixtures; an 8,000-character long line; native clipboard paste;
selection telemetry; and explicit mount/unmount control. The manual matrix is:

1. Type and compose Unicode with the platform keyboard.
2. Select across lines and replace the selection.
3. Copy the fixture, paste with the native menu, then invoke platform undo.
4. Scroll the long line and long document with the keyboard open.
5. Unmount and remount with the keyboard open and closed.
6. Confirm Markdown punctuation remains visible throughout.

### Static evidence (2026-08-06)

- `bun --filter @nautilo/mobile lint`: pass.
- `bun test apps/mobile/src/features/artifact-editing/markdown-ranges.test.ts`:
  3 pass, 0 fail.
- Disposable `npx expo prebuild --no-install --platform all`: pass; both native
  projects generated without changing the source worktree.
- Android `:app:assembleDebug` for `arm64-v8a`: pass; RNLiveMarkdown Java and
  CMake targets compile and the debug APK packages successfully.
- iOS Simulator `xcodebuild` (Debug, no code signing): pass; RNLiveMarkdown
  autolinking, codegen, pod compilation, linking, and app validation succeed.
- `npx expo-doctor@latest`: 19/20 checks pass. The only reported mismatch is the
  workspace resolving TypeScript `5.9.3` while the mobile package requests
  `~6.0.3`; this predates D501. Expo Doctor did not report the deliberate worklets
  patch after lockfile reconciliation.
- Full mobile TypeScript check is currently blocked by two pre-existing errors in
  `settings/agent-photos.tsx` and `lib/notification-unread.test.ts`; no D501 file
  appears in the diagnostics.

### Isolated native evidence (2026-08-06)

Runtime isolation used only D501-owned resources: the `D501 Wave10 iPhone`
simulator (iOS 18.3), the clean `D501_Wave10` Android AVD (API 36.1), Metro on
port 8092, and the cloned `d501-wave10-stack302` server/profile. The existing
D468 simulators, builds, worktree, and notification stack were not stopped,
repointed, rebuilt, or overwritten.

| Harness row | iOS | Android |
| --- | --- | --- |
| Native keyboard / IME path | Pass. Software keyboard stayed visible in the keyboard-avoiding shell; direct native key presses updated the controlled source. | Pass. Direct Gboard key presses composed into the controlled source without corrupting adjacent Café/Japanese/Korean/Arabic/emoji text. |
| Unicode source fidelity | Pass. Initial fixture and clipboard round trip preserved Café, 東京, 한국어, مرحبا, and 🫖 exactly. | Pass. Initial fixture and clipboard round trip preserved the same Unicode corpus exactly. |
| Multiline selection | Pass. Native selection telemetry moved from `0–0` to `48–84`; handles remained visible above the software keyboard. | Pass. Native Shift+Up selection moved telemetry from `44–44` to `18–44` across a line boundary. |
| Paste / undo | Pass. Native paste replaced the selected range with the exact 71-character fixture; Command-Z restored the prior 179-character value and selection. | Pass. `KEYCODE_PASTE` inserted the exact Unicode/Markdown fixture; native Ctrl-Z restored the prior 158-character value. |
| Markdown syntax remains source | Pass. `#`, `**`, `_`, and link target punctuation remained visible while styled. | Pass. The same syntax remained visible while styled. |
| Keyboard-safe viewport | Pass. Editor, selected text, telemetry, and controls remained reachable above the iOS software keyboard. | Pass. Editor content and telemetry remained visible above Gboard in the smallest D501 AVD viewport. |
| Empty / mount teardown | Pass. Controlled unmount with the keyboard open dismissed the keyboard without a crash; remount restored the value. | Pass for ordinary fixture mount/focus lifecycle; process remained healthy through focus, keyboard dismissal, and route reload. |
| 3,900-character boundary | Pass. Full value mounted, styled, selected, and scrolled. | Pass. Full value mounted, styled, selected, and scrolled. |
| 16,000 characters / 8,000-character line | Pass in the isolated iOS simulator. | **Fail.** The app stopped responding long enough for Android to present `Nautilo isn't responding`; choosing Wait eventually rendered the value. This violates the task's responsiveness acceptance. |

### Adoption decision

Reject `@expensify/react-native-live-markdown@0.1.335` for D501 production use.
The result is not rescued by imposing a silent line-length limit: ordinary text
artifacts may legitimately contain long lines, and allocating a known-ANR input
would weaken the locked editing behavior.

The explicit plain native `TextInput` fallback was replayed for both Markdown
and ordinary text in `/(onboarding)/qualification/markdown-source`. Markdown
punctuation remains visible and Preview can supply rendered reading; no WebView,
browser editor, or custom selection machinery is introduced. The fallback is
uncontrolled during editing so React does not reassign `value` on every
keystroke and erase native history; fixture changes deliberately remount it.

The isolated iOS route preserved the full Unicode/Markdown fixture, accepted a
direct software-keyboard key, kept selection telemetry current, and mounted and
focused the 16,000-character / 8,000-character-long-line fixture responsively.
On a freshly rebooted D501 Android AVD, the same 16,000-character fixture mounted
and focused with Gboard attached without an ANR; selection moved to
`14933–14933`. Native paste inserted the exact 71-character two-line fixture and
updated the source from 150 to 221 characters. Android Ctrl-Z did not change the
221-character value, even after refocusing the core `ReactEditText`, both while
controlled and after switching the harness to uncontrolled editing.

A corrected hardware-shortcut replay separated key injection from editor
behavior. Android's `input keyboard keycombination -t 300 113 54` removed an
ordinary typed `X` (`222 → 221` characters), proving that core `TextView` undo
and the actual modifier chord work. Repeating the same chord did not remove the
preceding native paste (`221` characters remained), so the unresolved defect is
specifically the paste transaction rather than Ctrl-Z dispatch or React
controlled-value churn.

The already-required enriched control was also replayed as a possible literal
Markdown input (`useHtmlNormalizer={false}`, no mention or link detection, no
formatting commands). It preserved the 16,000-character source on initial mount,
but the 8,000-character first line subsequently produced the Android system ANR
surface during the interaction/restart sequence. That exploratory harness change
was reverted. Reusing the rich control for Markdown therefore does not satisfy
the responsiveness gate and is not an adoption path.

Do not advance the fallback to production yet. Task 0.2 remains open pending an
architecture-compliant native undo path or explicit acceptance replanning. A
custom JavaScript history/cursor engine is not an authorized workaround.

## 0.3 — `react-native-enriched-html`

### Exact Writer runtime Stage A (2026-08-07)

Status: **Writer semantics passed the first Android gate; the 6.12 MB React
Native prop transport failed and must be replaced before continuing.**

The qualification generator reproduced the exact current server-installed
Writer source hash
`24f8ef35b949a29cdfff0a1bcadea27133e13ba2882579f69c76c0c64f9e0387`,
the 6,107,609-byte server `srcDoc`, and the 6,120,912-byte document after the
real Desktop bridge client was inserted. The trusted Expo DOM host installed
its strict source-identity listener before assigning that document to an inner
`iframe sandbox="allow-scripts"`. It exposed no authentication, API, artifact
identifier, path, native action, or Expo module bridge.

On the isolated `D501_Wave10` Android AVD with Stack 302 Metro on port 8092:

- the exact runtime rendered the canonical supported Writer fixture and reached
  the bridge `read` state;
- a real Gboard key changed the heading and produced revision 2;
- Writer's own toolbar undo restored the original heading at revision 3, and
  redo restored the edit at revision 4;
- heading, bold, italic, underline, link, unordered-list, and ordered-list
  semantics were present after both history operations;
- the opaque inner frame had `window.nautiloApp` but no `window.expo`, and no
  app, artifact, path, room, or session authority globals;
- a forged read containing a top-level `artifactId` was rejected by the parent;
- a write with deliberately stale SHA/revision returned `kind: conflict`, and
  the following read had the same SHA and content.

The transport did not pass. A cold deep-link launch took roughly 45 seconds to
reach the editable surface. In the same debug binary, the Markdown qualification
route measured about 628 MB total PSS and zero WebViews; the Writer route measured
about 726 MB total PSS and one WebView, an approximately 98 MB increment. On
navigation away, Expo 57 also rejected a late
`DomWebView.injectJavaScript` call because the native view tag had already been
destroyed. This is an Expo DOM-prop lifecycle race, not a Writer document error.

Stage B keeps the exact source-hashed Writer runtime, Desktop bridge contract,
trusted outer host, and opaque script-only inner iframe. It must move runtime
loading/cache ownership out of the multi-megabyte serializable React Native prop
path and prove clean navigation teardown. Until then, touch selection, paste,
keyboard-safe long-document scrolling, the 80-paragraph fixture, isolated iOS,
real artifact save, and Desktop round trips remain unclaimed. The generated
runtime blob is ignored qualification data and must not be committed.

Stage B then moved the generated module import entirely into the `"use dom"`
host. Android export reduced the native bundle from about 19 MB to 7 MB and
produced a separate approximately 7.1 MB DOM bundle, proving that no runtime,
fixture, source hash, or document bytes cross the React Native prop bridge. The
isolated AVD reached the exact Writer `read` state in 9 seconds with development
Metro and 10 seconds with production/minified Metro. In that like-for-like
production-mode run, Markdown measured about 573 MB total PSS and Writer about
577 MB total PSS in the installed debug client. A true back/unmount produced no
late `DomWebView.injectJavaScript` rejection. Stage B therefore passes the
transport/lifecycle kill gate; the 80-paragraph Android interaction matrix and
iOS remain open.

The first keyed 80-paragraph fixture switch then reproduced the Expo
destroyed-view injection rejection and briefly reported two WebViews. CDP also
showed that the outer DOM document was shrink-wrapping: a 511 CSS-pixel WebView
contained a 150 px iframe and left Writer only a 35 px editor viewport. That
shell contract is rejected. The accepted replay keeps one outer DOM WebView
mounted, reloads only the inner `sandbox="allow-scripts"` iframe, and makes
`html/body/#root` fill the native viewport. The resulting Writer viewport was
485 px with a 370 px scrollable editor.

The isolated Android replay then kept exactly one WebView and logged no Expo
rejection while rendering all 80 canonical paragraphs. Native touch scrolling
moved from paragraph 1 through paragraph 80. With Gboard open, paragraphs 74–80
remained visible; a real key edited the bold run in paragraph 80. Writer-owned
undo and redo restored/reapplied the edit while all 80 stable block IDs,
paragraph records, bold marks, and italic marks remained. Reloading the inner
sandbox re-read the same saved revision and SHA rather than reverting it.
Android touch selection and paste, then the full isolated iOS matrix, remain
open.

Identical generator runs emitted both 6,107,609 / 6,120,912-byte and
6,107,615 / 6,120,918-byte server/bridged documents with the same source hash;
a later run returned to the first pair. Fixed byte constants are therefore not
a valid identity/security boundary. The harness verifies the generated
document's measured UTF-8 length against its own metadata and retains the source
hash as the Writer-source identity. The six-byte difference is build-output
nondeterminism, not a Writer source or semantic change.

The candidate then failed mandatory Android touch selection. An instrumented
finger drag produced `pointerdown`/`touchstart`, repeated
`pointermove`/`touchmove`, and `touchend` events on Wafflebase's hidden textarea,
but no `mousedown`/`mousemove`/`mouseup` drag sequence. Writer retained a
collapsed anchor/focus and published no selection-range context update. The
shipped `@wafflebase/docs@0.4.9` input controller registers only mouse events
for canvas selection; it has no touch/pointer selection path or mobile handles.
Android's synthesized click is sufficient for tap-to-caret but not drag-to-select.
Implementing correct long-press/drag handles and distinguishing selection from
scrolling is editor-engine work, not a transport or trusted-host patch, and would
cross D501's current prohibition on a Nautilo-built cursor/selection engine.
The exact current Writer runtime is therefore rejected. Paste and iOS rows were
not run after this first mandatory failure.

Status: **rejected from D501 production on both platforms**. Android loses
supported rich structure through native undo. iOS preserves structure, but the
whole-document adapter/control path does not scale to ordinary large Writer
artifacts or meet the final product-quality bar. The research remains useful;
the package, qualification route, adapter, toolbar, save bridge, and native
editor integration are removed from the shipping mobile application.

Android 36.1 platform source identifies the Writer boundary directly. Its
`android.widget.Editor.UndoInputFilter` contains `TODO: Make this span aware`;
`EditOperation` stores both old and new content as `String` and restores those
strings into the `Editable`. Text recovery can therefore succeed while native
formatting spans are irretrievably absent. This matches the live list/link/
emphasis loss exactly and rules out an adapter-only repair.

### Version and runtime boundary

- Candidate: `react-native-enriched-html` `1.1.0` (exact stable pin, published
  2026-07-30). The `1.2` line is currently nightly-only and is not eligible for
  an exact production pin.
- Upstream `main` and the current npm nightly
  `1.2.0-nightly-20260806-0fdac7a45` resolve to commit `0fdac7a45`. A source
  comparison from stable tag `v1.1.0` (`b2c22087c`) through that commit contains
  no changes under Android's enriched text-input implementation, so the current
  nightly does not contain a candidate span-aware undo fix to qualify.
- Nautilo's React Native `0.86.2`, React `19.2.5`, Fabric/New Architecture, and
  Expo prebuild runtime fall inside the package's documented native boundary.
- The native package is a Fabric component and does not use a WebView. Its
  `react-native` export resolves to the native implementation; web-only TipTap
  and DOMPurify dependencies do not become the native editor runtime.
- The package is uncontrolled: initial content enters through `defaultValue`,
  replacement content through imperative `setValue`, and canonical HTML is read
  on demand with `getHTML`. D501 must not treat per-keystroke HTML callbacks as
  the save boundary.

### Supported-subset intersection

The native implementation exposes paragraphs, headings, links, bold, italic,
underline, strike, inline code, and ordered/unordered lists. The package documents
only one list nesting level, which matches D501's locked initial subset. D501's
adapter must still reject the entire Writer document before mounting the editor
when the canonical Wafflebase envelope contains any structure outside the locked
subset. Package support is not permission to widen that subset.

Both native serializers emit a complete `<html>` envelope. The empty-document
shape is `<html>\n<p></p>\n</html>`. Exact cross-platform canonicalization remains
an acceptance gate: the adapter may normalize a proven, explicitly modeled
serializer dialect, but may never flatten or discard blocks or arbitrary HTML.

### Reproducible harness

The temporary `/(onboarding)/qualification/enriched-html` route exercised the
complete subset, mixed Unicode, native keyboard and selection behavior,
formatting commands, link creation, clipboard paste, HTML extraction, teardown,
and long documents. It was removed with the rejected dependency before review.

### Static evidence (2026-08-06)

- `bun --filter @nautilo/mobile lint`: pass.
- Full mobile TypeScript check reports only the two pre-existing diagnostics in
  `settings/agent-photos.tsx` and `lib/notification-unread.test.ts`; no D501 file
  appears in the diagnostics.
- Disposable `npx expo prebuild --no-install --platform all`: pass.
- iOS `pod install`: pass and autolinks `ReactNativeEnrichedHtml 1.1.0`.
- Android `:app:assembleDebug` for `arm64-v8a`: pass; the native module compiles,
  links, and packages in the disposable prebuild root.
- iOS Simulator `xcodebuild` (Debug, no code signing): pass for arm64 and x86_64;
  the native module compiles, links, validates, and produces `Nautilo.app`.
- No source native project was generated in the worktree.

### Isolated native evidence (2026-08-06)

The matrix used only the D501 iPhone simulator, D501 Android AVD, Metro 8092,
and the Stack 302 runtime. D468's worktree, processes, and installed builds were
not changed.

| Harness row | iOS | Android |
| --- | --- | --- |
| Supported subset render | Pass: paragraph, H1, bold, italic, underline, link, unordered list, and ordered list render natively. | Pass for the same subset. |
| Pristine HTML extraction | Pass: `getHTML()` returns the fixture byte-for-byte. | Pass after deterministic entity normalization: structure and tags match, while non-ASCII scalars are numeric entities. |
| Native keyboard / selection | Pass: direct software-keyboard taps changed `120` to `122` characters and selection to `122–122`; formatting state followed the caret. | Pass: Gboard mounted through `EnrichedTextInputConnectionWrapper`; cursor/selection telemetry and native clipboard input updated through the platform control. |
| Unicode paste | Pass: the exact Café/東京/한국어/مرحبا/🫖 fixture appended inside the current ordered-list item and extraction preserved all existing marks and blocks. | Pass: the same fixture appended at the native caret and text length moved from `120` to `148`. |
| Native undo fidelity | Pass for ordinary typed characters; the original HTML extraction remained exact after undo. | **Fail:** after paste followed by native Ctrl-Z, visible text returned from `148` to `120`, but `getHTML()` silently dropped italic, underline, and link marks and serialized every list item as a paragraph. Bold and headings survived. |
| Long document / keyboard-safe viewport | Pass: 80 styled paragraphs / 3,750 text characters remained responsive and selectable with the software keyboard shown. | Pass: the same 80-paragraph document rendered, focused, and kept Gboard connected without ANR. |
| Mount teardown | Pass: unmount with the software keyboard active dismissed the native input without crash; remount succeeded. | Ordinary route/process lifecycle remained healthy; a final focused unmount replay is still outstanding because the fidelity failure already blocks adoption. |

### Android suppression kill gate (2026-08-06)

The isolated D501 Android AVD replayed the exact destructive hardware shortcut
against a disposable native build. After appending one ordinary character, the
fixture reported `121` text characters. Ctrl-Z then returned it to `120`.

Four small, history-free interception seams were tested independently:

- `EnrichedTextInputView.dispatchKeyEvent()`;
- `EnrichedTextInputView.onKeyShortcut()`;
- `EnrichedTextInputConnectionWrapper.sendKeyEvent()`; and
- `MainActivity.dispatchKeyShortcutEvent()`, guarded by the exact focused native
  Writer view class.

In every replay the text changed from `121` to `120`, and no interception log
fired. This proves the observed Android shortcut reaches platform undo outside
the package/view seams Nautilo can patch narrowly. Continuing would require
broader Activity key ownership, undocumented OS/IME assumptions, or a custom
span-aware history engine. Those are not small auditable fixes and are outside
D501's locked architecture. The temporary native spike changed only ignored
`node_modules` and a disposable prebuild; no suppression patch is retained.

### One-snapshot repair kill gate (2026-08-06)

The next bounded spike tested recovery rather than shortcut interception. Before
editing, the harness captured one native `getHTML()` result plus its plain-text
projection. A real Android native paste changed the fixture from `120` to `148`
text characters. Native Ctrl-Z then reproduced the platform rollback. When the
plain text returned to the captured pre-edit value, the harness restored the
captured HTML through the package's existing imperative `setValue()` boundary.

The repaired control reported `120` characters and selection `120–120`. A fresh
native `getHTML()` result compared byte-for-byte equal to the pre-edit snapshot,
including the H1, ordered and unordered lists, link, bold, italic, underline,
Unicode content, and Android's numeric-entity serializer dialect. This proves a
bounded exact repair is technically possible without WebView use, arbitrary HTML
editing, or a homegrown cursor/selection engine.

This is not yet proof of a production history adapter. The next kill gate must
automatically maintain a minimal rolling history across consecutive edits and
prove edit/undo/continued-edit behavior without stale asynchronous snapshots,
selection jumps, or unbounded document copies. If that fails, reject the package;
do not expand into a general JavaScript cursor or selection engine.

### Automatic rolling-history kill gate (2026-08-06)

The harness replaced manual arming with a debounced three-slot window containing
only previous, current, and redo HTML/plain-text snapshots. Each asynchronous
`getHTML()` capture carries a generation and expected plain text, so stale work
is discarded. No key event or cursor offset is calculated.

The supported 120-character corpus passed the content rows: native paste captured
`120→148`; hardware Ctrl-Z automatically recognized the adjacent prior state and
restored byte-identical HTML; hardware Ctrl-Shift-Z restored the exact 148-character
redo state; a subsequent ordinary edit captured `148→149`; and another hardware
undo restored the exact 148-character rich document. The clean 80-paragraph
default fixture also captured and restored `3,750→3,778→3,750` without an ANR or
HTML mismatch. Loading that fixture through `setValue()` instead of as the native
default polluted Android's undo stack and produced `3,778→3,690`; production must
therefore never treat programmatic document replacement as a transparent edit.

The selection row failed. In the clean long-document replay, the native caret was
`675–675` before paste. Exact HTML repair through `setValue()` reset it to `0–0`.
The harness captured the native coordinates and replayed them with the package's
public `setSelection()` command. A direct command after the parser became idle
worked, but commands issued after fixed delay, after `getHTML()` resolution, and
after the native selection-reset event were all subsequently overwritten back to
`0–0` by later parser work. The package exposes no stable replacement-complete
signal. Repeatedly policing selection until it stays put would be a homegrown
selection engine or undocumented timing heuristic, which D501 explicitly forbids.

Result: the bounded content-history primitive works, but the native editor shell
does not remain cursor-usable after repair. Reject this Android path. Preserve the
harness and ledger as evidence; do not escalate into global key interception,
selection polling, or arbitrary delays.

### Atomic native restore kill gate (2026-08-06)

The final enriched salvage spike added a temporary Android-native
`setValueAndSelection(html, start, end)` command to the package qualification
copy. It parsed and replaced the HTML and restored visible selection in one
native command. Two bounded placements were tested: selection inside the
package's existing `runAsATransaction` block before layout invalidation, and
selection in the same command immediately after `layoutManager.invalidateLayout()`.
Both variants compiled and produced an arm64 debug APK on Expo 57/RN 0.86.2.

Both live replays failed identically on the isolated `D501_Wave10` API 36.1 AVD.
The 80-paragraph fixture captured `3,750` characters and selection `675–675`;
native paste produced `3,778` and `703–703`; Ctrl-Z plus rolling repair returned
byte-identical HTML and `3,750` characters. The expected `675–675` selection was
observed transiently, proving the combined command executed, but later package/
Fabric work reset the stable selection to `0–0`. Moving selection across the
layout invalidation boundary did not change the result.

Result: a combined public/native restore command is insufficient. The remaining
enriched salvage would require editor-owned structured history integrated with
the control's full native lifecycle, not an auxiliary snapshot library or
Nautilo timing logic. The temporary API, generated command surface, native
implementation, and gate-only controls were removed; no package patch or fork is
retained.

### Adoption decision and upstream handoff

Do not ship `react-native-enriched-html@1.1.0` in D501 on either platform.
Android native undo removes semantic spans and list boundaries before `getHTML()`
can expose them; repairing it externally would require Nautilo-owned selection
management. iOS preserved the supported subset, but a measured 546,268-byte
document needed 8,560 ms to become editable and 5,777 ms to extract, while a
1,091,372-byte document needed 19,907 ms and 11,908 ms respectively. Both
completed typing, scrolling, extraction, teardown, and remount, proving that the
failure is product usability and whole-document architecture rather than a
parsing ceiling.

Markdown/plain-text editing remains enabled through native source input on both
platforms. Writer artifacts remain native, readable, and read-only on both.
D501 adds no “unsupported,” “Edit on Desktop,” “coming soon,” or other
capability/future-support message.

The Android span-destructive undo defect and this ledger's failed recovery
experiments are filed upstream as
[`software-mansion/react-native-enriched-html#749`](https://github.com/software-mansion/react-native-enriched-html/issues/749),
including a public minimal reproduction. A later, separately authorized effort
may explore a dependency-owned span-aware structured-history fix and contribute
it upstream. D501 does not carry a fork or package patch, poll selection, own
global shortcut routing, or promise future application behavior.

The proper follow-on is a mobile structured-document architecture with a stable
block index, virtualized edit window, canonical Wafflebase identity, and
selection/history owned by the editor engine. It belongs in a dedicated later
mobile wave after server-management work, not as another package spike inside
D501. The rejected candidate evidence below remains the cleanup and
future-research ledger.

## 0.3 replacement-control ledger

This ledger is the cleanup authority for dependencies tried after rejecting
`react-native-enriched-html` on Android. A candidate stops at its first failed
gate; later rows are explicitly recorded as not run rather than inferred.

### `@apollohg/react-native-prose-editor@0.5.25` — rejected

**Why tried:** the package is native on Android and iOS, accepts Expo `>=52` and
React Native `>=0.76`, exposes HTML and ProseMirror JSON snapshots, and owns a
Rust-backed structured document/history engine with API undo/redo. Those seams
could satisfy D501 without Nautilo implementing cursor, selection, or history.

**Passed gates:** exact package installation, Expo 57 config-plugin evaluation,
disposable Android prebuild, autolinking as Expo module
`apollohg-react-native-prose-editor` `0.5.25`, and a clean arm64 Android debug
build on RN `0.86.2`, API/target 36, and New Architecture. The package required
no source patch. Its documented JNA legacy-ABI exclusions were applied by its
own config plugin. The candidate harness passed mobile lint; its only TypeScript
diagnostic was an unsupported `testID` prop, removed before live testing.

**Failed gate:** Android application startup responsiveness on the isolated
`D501_Wave10` API 36.1 AVD. The first launch was killed by Android with
`failed to complete startup`. One allowed warm retry started process `6311` at
`17:41:30`, did not schedule the React surface until `17:41:48`, did not create
the Metro bundle loader until `17:42:13`, and did not report the JS bundle loaded
until `17:42:24`. The UI remained blank beyond `17:42:40`; startup logged 381
skipped frames. The previously qualified D501 APK cold-started on the same AVD
in about 3.7 seconds. This candidate therefore fails before Writer content
hydration and is rejected without package patching.

**Not run:** supported-subset hydration/extraction, native paste, hardware/API
undo/redo fidelity, long-document editing, iOS build/live behavior, and focused
teardown. No claim is made that those rows fail; startup already makes the
dependency ineligible.

**Footprint and cleanup:** the npm artifact contains 68 files and unpacks to
`98,912,618` bytes; the candidate arm64 debug APK was `103,075,228` bytes.
`apps/mobile/package.json`, `app.json`, `bun.lock`, the candidate harness route,
and `node_modules/@apollohg/react-native-prose-editor` were restored/removed
after rejection. A forced Bun reinstall also removed the prior ignored enriched
undo-suppression spike. The rejected APK was uninstalled from the dedicated
`emulator-5560`; the disposable prebuild still contains the candidate and must
be regenerated before the next build. Shared D468 devices, builds, worktree,
and runtime were not touched.

**Next decision:** do not resume package search automatically. The enriched
atomic-restore salvage is disproven; any further enriched work must be an
upstream/dependency-owned structured-history implementation. Otherwise select
the next native replacement candidate and apply the same first-failure gates.

### `com.mohamedrejeb.richeditor:richeditor-compose:1.0.0` — direct adoption rejected

**Why tried:** Compose Rich Editor is Apache-2.0, recently released, native, and
owns rich-document history snapshots including selection and IME composition.
It therefore attacks the exact Android failure in `react-native-enriched-html`
without asking Nautilo to invent history or cursor behavior.

**Passed gates:** the exact artifact resolved from Maven Central; an Android-only
local Expo module autolinked into the real Expo 57 application as
`d501-compose-rich-editor` `0.1.0`; Gradle consumed the dependency metadata and
advanced to Kotlin compilation. No React Native bridge or editor adapter code was
needed to reach the compatibility gate.

**Failed gate 1 — stock Expo toolchain:** the released artifact and Kotlin
standard library carry Kotlin metadata `2.4.0`. The gate was replayed after
updating Nautilo from `expo@57.0.10` to the current stable patch
`expo@57.0.11`; the generated project still configures Kotlin `2.1.20`, whose
compiler accepts metadata only through `2.2.0`. Compilation of the local module
failed with `binary version ... 2.4.0, expected ... 2.1.0`.

**Failed gate 2 — app-level Kotlin override:** setting Expo build properties to
Kotlin `2.4.0` changed the root project version, but `expo-modules-core` still
compiled through its pinned Kotlin `2.1` toolchain and failed against the now
resolved Kotlin 2.4 standard library and reflection metadata. Suppressing the
metadata check would hide an unsupported binary boundary and is not an adoption
path.

**Not run:** Fabric view startup, HTML import/export, selection, native IME,
paste, undo/redo, the 80-paragraph replay, APK footprint, and iOS behavior. The
dependency cannot enter the current Android binary, so later fidelity claims
would be meaningless.

**Footprint and cleanup:** the generated local module, disposable Android
prebuild, and temporary Kotlin override were removed after the failures. The
independently valid Expo `57.0.11` patch update is retained. No editor package,
source fork, Gradle suppression, or runtime build is retained. The D501 AVD was
not modified and D468 resources were not touched.

**Next decision:** stock `1.0.0` cannot be adopted on Expo 57. The only credible
Compose continuation is a source fork/backport published with Expo 57's Kotlin
and Compose toolchain, followed by the full live fidelity matrix. That is a
material maintenance commitment, not a wrapper-only integration.
