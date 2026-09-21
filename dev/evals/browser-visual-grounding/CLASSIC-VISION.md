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

- fast or accurate `VNRecognizeTextRequest` OCR;
- `VNDetectRectanglesRequest` for projected rectangles; and
- `VNDetectContoursRequest` for residual contrast boundaries.

Accurate mode also enables language correction and fixes the recognition
language to `en-US`. The Swift helper emits JSON lines in original screenshot
pixels. It runs wholly on the machine and does not contact a model provider.
Its platform limitation is explicit: it is an experiment for the current macOS
Desktop path, not the cross-platform product implementation.

## Experiment B: portable Tesseract baseline

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

## Experiment C: cross-platform PP-OCRv6

The stronger portable comparison runs RapidOCR 3.9 with ONNX Runtime and the
PP-OCRv6 `tiny` and `small` detection/recognition tiers. One Python process
initializes one engine and processes the whole corpus, so model initialization
is measured separately instead of paid once per screenshot. Sharp supplies the
same colour-edge regions as the Tesseract baseline; only the OCR engine changes.

The harness launches these dependencies in an isolated `uv` environment rather
than changing Nautilo's product dependencies. This is intentional for the
experiment, but is not the shipping design: a product implementation must
vendor and sign the models and inference runtime, expose an owned adapter, and
avoid requiring a user's Python or `uv` installation. CPU ONNX is the portable
baseline. CoreML execution was also probed, but its dynamic shapes produced
provider fallbacks and noisy E5RT warnings, so those numbers are not used as
the cross-platform result.

Every OCR target also receives deterministic spatial context: its normalized
viewport position, nearest text above, and nearest heading-like section above.
This small layout graph is task-independent. It distinguishes repeated labels,
such as the two visible calendar cells named `10`, without asking another model
to interpret the screenshot.

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

Run extraction and coverage for all available backends on macOS:

```sh
bun dev/evals/browser-visual-grounding/run-classic-baseline.ts --backend all
```

Run one backend or case:

```sh
bun dev/evals/browser-visual-grounding/run-classic-baseline.ts \
  --backend ppocr-v6-small --case room6-checkout
```

Run all extractors and then the production Jev choice loop:

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

## Stronger-OCR and layout comparison

The final live run used the exact generated snapshot and candidate list for 40
real `openrouter:typesafe/jev-1.13` choices. All provider calls completed. Jev
itself averaged 508 ms and peaked at 871 ms. Extraction timing excludes the
one-time engine initialization and isolated-environment startup; PP-OCR and
Sharp are currently run sequentially, so their reported total can be reduced
by overlapping the two independent passes in a product adapter.

| Extractor | Coverage | Correct Jev choice | Mean extraction | Mean extraction + Jev | Choices |
| --- | ---: | ---: | ---: | ---: | ---: |
| Apple Vision fast | 8/8 | 7/8 | 53.8 ms | 547.4 ms | 63–92 |
| Apple Vision accurate | 8/8 | 7/8 | 206.4 ms | 767.2 ms | 63–120 |
| Tesseract + Sharp | 8/8 | 3/8 | 311.2 ms | 807.0 ms | 25–122 |
| PP-OCRv6 tiny + Sharp | 8/8 | 7/8 | 448.6 ms | 932.9 ms | 25–115 |
| PP-OCRv6 small + Sharp | 8/8 | **8/8** | 748.1 ms | 1,252.6 ms | 25–122 |

Warm PP-OCR engine initialization was 91.5 ms for tiny and 117.1 ms for small
in this run. The result file is
`.results/2026-09-21T11-38-09-883Z-classic-live.json`.
An immediate PP-OCRv6-small-only repeat also passed 8/8, with a 587.5 ms mean
extraction time after caches were warm; its report is
`.results/2026-09-21T11-40-45-783Z-classic-live.json`.

The failures are informative:

- Both Vision modes still miss the small puzzle-piece `8`; accurate mode costs
  roughly four times as much without changing the decision outcome.
- PP-OCRv6 tiny reads that `8` at 99.98% confidence but omits the small row
  marker `1` in the table case, leaving two Number fields ambiguous.
- PP-OCRv6 small reads both and is the only 8/8 extractor in the final run.
- Before spatial context was added, both PP-OCR tiers were 7/8 because Jev
  selected September `10` instead of October `10`. Adding deterministic
  position, nearest-label, and section relationships makes both select the
  correct October cell. OCR alone is therefore not the complete solution.

## Apple selective-crop follow-up

The global Apple failure is scale-sensitive rather than an absolute recognition
failure. Accurate Vision still misses puzzle piece `8` in the full 2168×1404
screenshot, but recognizes it at confidence 1.0 when given its existing
control-sized rectangle as a crop.

The hybrid backend therefore keeps fast Vision for the whole viewport and runs
accurate Vision only for an unlabelled control-sized rectangle that contains a
smaller text-like contour. This is task-independent and reuses the rectangle
and contour observations already produced by the first request. On the puzzle
case it performs seven crop requests and recovers `8`; on the other cases it
performs zero to four.

One live eight-case run produced:

| Extractor | Coverage | Correct Jev choice | Mean extraction | Slowest extraction | Mean extraction + Jev |
| --- | ---: | ---: | ---: | ---: | ---: |
| Apple Vision fast + accurate crops | 8/8 | **8/8** | **119.7 ms** | **212.7 ms** | **845.5 ms** |

Six of eight individual calls completed below one second. The other two were
caused solely by Jev latency of 1.03 s and 1.51 s; extraction remained below
213 ms. A repeat encountered a Jev provider call that had still not returned
after 90 seconds and was interrupted, further separating provider tail latency
from local visual extraction. The successful run is recorded in
`.results/2026-09-21T14-24-20-438Z-classic-live.json`.

## Recommended next design

Use PP-OCRv6 small as the cross-platform quality reference, not yet as a
shipping dependency. Build the product path as an owned local visual-observation
adapter with four explicit stages:

1. Decode once and run colour/edge region detection and OCR concurrently.
2. Attach OCR to regions and build deterministic containment, row, column,
   nearest-label and section relationships.
3. Emit the ordinary browser snapshot plus a short-lived registry from each
   `visual_ref` to image coordinates.
4. Let the existing Jev loop choose among those references plus `scroll_up`
   and `scroll_down`.

For latency, evaluate a cascade rather than committing immediately to the
small tier on every frame: run tiny first, then apply small recognition only to
unlabelled or low-confidence control-sized crops. The corpus already shows why
the fallback is necessary (`room10`) and why it should be selective (tiny is
about 300 ms faster on average). On macOS, the proven equivalent is fast Vision
plus selective accurate crops: it is both faster and more accurate here than
global accurate Vision. Keep it behind the same adapter contract rather than
making the snapshot format platform-specific. Finally, prune nested duplicate
edge regions before Jev—the current 25–122 choices work, but are more than the
semantic controls on screen and increase ambiguity and token volume.

## Upstream references

- [Apple: Recognizing text in images](https://developer.apple.com/documentation/vision/recognizing-text-in-images)
- [Apple: VNRequestTextRecognitionLevel](https://developer.apple.com/documentation/vision/vnrequesttextrecognitionlevel)
- [PaddleOCR releases](https://github.com/PaddlePaddle/PaddleOCR/releases)
- [RapidOCR](https://github.com/RapidAI/RapidOCR)
