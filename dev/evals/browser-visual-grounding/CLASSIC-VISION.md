# Local classic visual grounding experiments

## Recommendation

Generate the screenshot-derived browser observation locally and leave the
choice of action to Jev. The extractor should not receive the task. It should
produce a deliberately neutral inventory of visible text and plausible visual
regions, plus a registry from every `visual_ref` to its image-pixel box and safe
click point.

Use three independent signals:

1. OCR supplies visible text, confidence, and bounding boxes.
2. Rectangle or connected-region detection supplies labelled and unlabelled
   control-sized regions.
3. A perceptual-colour gradient supplies boundaries that differ chromatically
   even when their luminance is similar.

Associate OCR with the smallest enclosing region, retain nearby text as
context for empty controls, remove near-duplicate regions, order the remaining
observations top-to-bottom and left-to-right, and append the ordinary
`scroll_up` and `scroll_down` operations. Do not infer that a region is a
button, field, or other semantic role when pixels do not establish that fact.

Raw contours are diagnostic evidence, not Jev candidates. Glyphs, shadows and
nested borders make an unfiltered contour inventory both enormous and
misleading. This harness records raw counts and supplies Jev only filtered,
deduplicated text and region candidates.

## Experiment A: macOS-native

The immediate prototype uses one local Apple Vision request handler with:

- fast `VNRecognizeTextRequest` OCR;
- `VNDetectRectanglesRequest` for projected rectangles; and
- `VNDetectContoursRequest` for residual contrast boundaries.

The Swift helper emits JSON lines in original screenshot pixels. It runs wholly
on the machine and does not contact a model provider. Its platform limitation
is explicit: it is an experiment for the current macOS Desktop path, not the
cross-platform product implementation.

## Experiment B: portable

The portable prototype uses:

- Tesseract's TSV output for local OCR word boxes; and
- the Sharp dependency Nautilo already ships to decode into LAB colour space,
  calculate three-channel neighbour differences, dilate the resulting edge
  map, and form connected visual regions.

This version requires a local `tesseract` executable. A production packaging
decision can later choose a vendored native executable, Tesseract.js/WASM, or a
platform OCR adapter. OpenCV is deliberately deferred: it provides stronger
Canny, contour and connected-component primitives, but adds a new native or
WASM distribution surface before the corpus demonstrates that Sharp's smaller
implementation is inadequate.

## What the experiment proves

For each backend and capture, the report distinguishes:

- **coverage** — at least one generated click point falls within the reviewed
  target region;
- **decision correctness** — Jev selects a point in that region; and
- **latency and volume** — extraction time, raw observation counts, filtered
  regions, candidates, Jev calls and Jev latency.

Coverage is necessary but not sufficient. It does not prove that an unlabeled
region is understandable to Jev or that clicking its center is safe. The live
Jev result and the retained snapshot are the decision-level evidence.

Strictly, both modern Tesseract and Apple OCR contain trained recognition
components. "Model-free" here means no generative model, no task-conditioned
visual reasoning, no provider request, and no screenshot data leaving the
machine during extraction.

## Commands

Run extraction and coverage for both backends on macOS:

```sh
bun dev/evals/browser-visual-grounding/run-classic-baseline.ts --backend all
```

Run one backend or case:

```sh
bun dev/evals/browser-visual-grounding/run-classic-baseline.ts \
  --backend portable --case room6-checkout
```

Run both extractors and then the production Jev choice loop:

```sh
OPENROUTER_API_KEY=... \
  bun dev/evals/browser-visual-grounding/run-classic-baseline.ts \
  --backend all --live
```

Mode-600 reports are written under the ignored `.results/` directory, and
`.results/classic-latest.json` points to the latest run.

## Initial eight-case extraction result

The first complete extraction-only run on the captured 2168×1404 corpus found
at least one candidate click point inside every reviewed target region for both
backends:

| Backend | Coverage | Mean extraction | Slowest case | Jev choices per case |
| --- | ---: | ---: | ---: | ---: |
| macOS Vision | 8/8 | 58.8 ms | 117.1 ms | 63–92 |
| Tesseract + Sharp | 8/8 | 271.4 ms | 422.7 ms | 25–122 |

The native timing includes image decode and all three Vision requests. The
portable OCR and edge passes run concurrently, so its extraction total is wall
time rather than the sum of both passes. These numbers exclude Jev. Target
coverage only proves that the choice set contains a geometrically acceptable
action; a live run is still required to measure whether Jev can understand and
select it from the neutral snapshot.

Manual inspection found the important failure mode behind that caveat. Both
backends found the correct geometry for the second-row `8` tile, but neither
gave it a reliable `8` label. Tesseract also found the room 2 button geometry
without reading its white-on-blue label. Conversely, both approaches produced
useful labels or nearby context for the dropdowns, checkout quantity, profile
clue and ordinary form-field cases. The next improvement should therefore be
local crop-level OCR on each retained region (including inverted and enlarged
crops), not a larger global region inventory.

## Initial live Jev result

The first full live matrix sent every generated snapshot and candidate set to
`openrouter:typesafe/jev-1.13`. All 16 provider calls completed without an API
error or a screening round. Jev selection took 538 ms on average and 1.304 s
in the slowest case.

| Backend | Geometric coverage | Correct Jev selection | Incorrect selection |
| --- | ---: | ---: | ---: |
| macOS Vision | 8/8 | 6/8 | 2/8 |
| Tesseract + Sharp | 8/8 | 3/8 | 5/8 |

The native extractor failed on the unlabeled second-row `8` tile and on the
calendar's duplicated `10` values. The portable extractor passed the ordinary
form and both dropdown cases, but lacked sufficient labels for the room 2
button, profile clue and `8` tile; it also selected the wrong row-one Number
field and the wrong duplicated calendar `10`.

This confirms that region coverage is already adequate, while semantic
attachment is the limiting factor. Crop-level OCR should be evaluated first.
The calendar result also requires structural context—such as row, column or
enclosing-group relationships—because perfect OCR alone cannot distinguish two
visible controls with the same text.
