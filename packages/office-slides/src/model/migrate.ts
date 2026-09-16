import type {
  Background,
  Guide,
  GuideAxis,
  Layout,
  Meta,
  Slide,
  SlidesDocument,
} from './presentation';
import type { Element } from './element';
import type { GradientFill, Theme, ThemeColor } from './theme';
import type { Master } from './master';
import { DEFAULT_MASTER } from './master';
import { generateId } from './element';
import { defaultLight } from '../themes/default-light';

/**
 * Renamed layout ids, keyed by their pre-rename value.
 *
 * A `Map`, not an object literal: `layoutId` arrives from stored JSON (and
 * from `PUT /content`, which accepts any non-empty string), so an object
 * lookup would resolve `"constructor"` / `"__proto__"` / `"toString"` off
 * `Object.prototype` and hand a function — or `Object.prototype` itself — back
 * as the migrated layout id.
 */
const LAYOUT_ID_MIGRATIONS = new Map<string, string>([
  ['title', 'title-slide'],
]);

/**
 * Compatibility migration boundary.
 *
 * These helpers apply legacy defaults and narrowly documented shape
 * transformations to a document that its host has already validated. They do
 * not validate an untrusted document at runtime: several current-format
 * fields are deliberately preserved by type assertion so migration does not
 * discard data it does not own. Callers accepting external input must validate
 * both the source and the migrated result with the host's document schema.
 */

type LegacyRecord = Record<string, unknown>;

function legacyRecord(value: unknown): LegacyRecord {
  return value !== null && typeof value === 'object'
    ? (value as LegacyRecord)
    : {};
}

function legacyArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? (value as unknown[]) : undefined;
}

/**
 * Migrate just the document metadata: fill defaults and preserve the
 * optional fields (`unit`, `pxPerPt`, `slideHeight`, `recentColors`) that
 * would otherwise be dropped on every read. Split out of
 * {@link migrateDocument} so `SlidesStore.readMeta()` can migrate meta
 * without scaffolding a whole default document (themes / masters / …).
 * This is a compatibility transform, not an input validator; see the module
 * boundary note above.
 */
export function migrateMeta(rawMeta: unknown): Meta {
  const m = legacyRecord(rawMeta);
  const meta: Meta = {
    title: (m.title ?? 'Untitled presentation') as string,
    themeId: (m.themeId ?? 'default-light') as string,
    masterId: (m.masterId ?? 'default') as string,
  };
  // Preserve the optional unit field if present and valid.
  if (m.unit === 'in' || m.unit === 'cm') {
    meta.unit = m.unit;
  }
  // Preserve the deck-DPI font scale. PPTX-imported decks set this
  // from `<p:sldSz>`; without the migrate-time copy the field is
  // dropped on every Yorkie read and the renderer falls back to the
  // 96-DPI docs default — which is exactly the original bug.
  if (typeof m.pxPerPt === 'number' && Number.isFinite(m.pxPerPt) && m.pxPerPt > 0) {
    meta.pxPerPt = m.pxPerPt;
  }
  // Preserve the per-deck logical height. Like pxPerPt, non-16:9 decks
  // set this from `<p:sldSz>`; without the migrate-time copy the field is
  // dropped on every Yorkie read and the deck renders stretched into the
  // default 1080 canvas — the exact distortion this field fixes.
  if (
    typeof m.slideHeight === 'number' &&
    Number.isFinite(m.slideHeight) &&
    m.slideHeight > 0
  ) {
    meta.slideHeight = m.slideHeight;
  }
  // Preserve persisted recent colors exactly. Normalization belongs to the
  // explicit `pushRecent` write path; applying it during adoption would rewrite
  // otherwise valid source data merely by opening the deck. Legacy non-string
  // entries are still filtered defensively.
  const recentColors = legacyArray(m.recentColors);
  if (recentColors) {
    meta.recentColors = recentColors.filter(
      (color): color is string => typeof color === 'string',
    );
  }
  return meta;
}

/**
 * Apply legacy compatibility transforms to a host-validated slides document.
 * This function does not establish that `input` is a valid `SlidesDocument`.
 * Hosts must schema-validate untrusted input before migration and validate the
 * result before storing or rendering it.
 */
export function migrateDocument(input: unknown): SlidesDocument {
  const raw = legacyRecord(input);
  const rawThemes = legacyArray(raw.themes);
  const rawMasters = legacyArray(raw.masters);
  const rawLayouts = legacyArray(raw.layouts);
  const rawSlides = legacyArray(raw.slides);
  const rawGuides = legacyArray(raw.guides);
  const meta = migrateMeta(raw.meta);
  const themes = rawThemes && rawThemes.length > 0
    ? rawThemes as Theme[]
    : [defaultLight];
  const masters = rawMasters && rawMasters.length > 0
    ? rawMasters as Master[]
    : [DEFAULT_MASTER];
  const layouts = rawLayouts?.map(migrateLayout) ?? [];
  const slides = rawSlides?.map(migrateSlide) ?? [];
  // Pre-ruler decks did not carry `guides`. Default to an empty array
  // so consumers downstream never see undefined and the read-path stays
  // shape-stable across pre- / post-v0.4.2 documents.
  const guides = rawGuides?.map(migrateGuide) ?? [];
  return { meta, themes, masters, layouts, slides, guides };
}

/**
 * Normalise a guide-shaped value from an already host-validated document into
 * a `Guide`. This is limited compatibility repair, not general validation.
 * Two repairs vs. raw shape pass-through:
 *
 * - **id**: synthesised when missing or non-string. Without this the
 *   editor's hit-test treats a guide-shaped object as targetable
 *   (axis + position are enough) but moveGuide / removeGuide call
 *   into the store with `undefined`, which then throws
 *   `Guide not found: undefined`.
 * - **position**: only accepted if finite. `NaN` / `Infinity` would
 *   otherwise propagate into the snap engine's `Math.abs(diff)` math
 *   and corrupt drag dx/dy, and into the overlay's
 *   `position * scale` arithmetic.
 */
function migrateGuide(value: unknown): Guide {
  const g = legacyRecord(value);
  const id = typeof g.id === 'string' && g.id.length > 0 ? g.id : generateId();
  const axis: GuideAxis = g.axis === 'y' ? 'y' : 'x';
  const rawPos = g.position;
  const position =
    typeof rawPos === 'number' && Number.isFinite(rawPos) ? rawPos : 0;
  return { id, axis, position };
}

function migrateLayout(value: unknown): Layout {
  const layout = legacyRecord(value);
  const out: Record<string, unknown> = {
    id: layout.id ?? 'blank',
    masterId: layout.masterId ?? 'default',
    name: layout.name ?? layout.id ?? 'Layout',
    placeholders: layout.placeholders ?? [],
    staticElements: layout.staticElements ?? [],
  };
  if (layout.background != null) out.background = migrateBackground(layout.background);
  return out as Layout;
}

function migrateSlide(value: unknown): Slide {
  const slide = legacyRecord(value);
  const rawLayoutId =
    typeof slide.layoutId === 'string' && slide.layoutId.length > 0
      ? slide.layoutId
      : 'blank';
  const layoutId = LAYOUT_ID_MIGRATIONS.get(rawLayoutId) ?? rawLayoutId;
  const migrated: Record<string, unknown> = {
    id: slide.id,
    layoutId,
    background: migrateBackground(slide.background ?? {}),
    elements: legacyArray(slide.elements)?.map(migrateElement) ?? [],
    notes: slide.notes ?? [],
  };
  // Preserve optional per-slide theme, transition and animations fields.
  if (typeof slide.themeId === 'string' && slide.themeId.length > 0) migrated.themeId = slide.themeId;
  if (slide.transition != null) migrated.transition = slide.transition;
  if (slide.animations != null) migrated.animations = slide.animations;
  return migrated as Slide;
}

function migrateBackground(value: unknown): Background {
  const bg = legacyRecord(value);
  const out: Background = {};
  // Preserve an absent fill as "inherit" (slide → layout → master →
  // background role). Only wrap a fill that is actually set; never
  // synthesize a white default — an inheriting slide resolves to the
  // `background` role, which is white for default-light, so old decks
  // look identical. A gradient fill routes through `migrateGradientFill`
  // (same split `migrateElement` already uses for shape fills) so it
  // survives instead of being treated as an opaque `ThemeColor`.
  if (bg.fill != null) {
    const fill = legacyRecord(bg.fill);
    out.fill =
      fill.kind === 'gradient'
        ? migrateGradientFill(bg.fill)
        : wrapColor(bg.fill);
  }
  if (bg.image != null) out.image = bg.image as Background['image'];
  return out;
}

function migrateElement(value: unknown): Element {
  const el = legacyRecord(value);
  if (el.type !== 'shape') return value as Element;
  const data = { ...legacyRecord(el.data) };
  if (data.fill != null) {
    const fill = legacyRecord(data.fill);
    data.fill =
      fill.kind === 'gradient'
        ? migrateGradientFill(data.fill)
        : wrapColor(data.fill);
  }
  if (data.stroke != null) {
    const stroke = legacyRecord(data.stroke);
    // Resolved string colors are part of the current Stroke model. Preserve
    // them exactly; only legacy non-string values need compatibility wrapping.
    data.stroke = {
      ...stroke,
      color:
        typeof stroke.color === 'string'
          ? stroke.color
          : wrapColor(stroke.color),
    };
  }
  return { ...el, data } as Element;
}

function wrapColor(c: unknown): ThemeColor {
  if (typeof c === 'string') return { kind: 'srgb', value: c };
  if (c && typeof c === 'object' && 'kind' in c) return c as ThemeColor;
  return { kind: 'role', role: 'background' };
}

/**
 * Normalize a stored gradient fill. Documents written before the radial
 * work carry no `type`; they were all linear, so backfill `type:'linear'`.
 */
export function migrateGradientFill(value: unknown): GradientFill {
  const raw = legacyRecord(value);
  return {
    kind: 'gradient',
    type: raw.type === 'radial' ? 'radial' : 'linear',
    angle: typeof raw.angle === 'number' ? raw.angle : 0,
    center: raw.center as GradientFill['center'],
    stops: (legacyArray(raw.stops) ?? []) as GradientFill['stops'],
  };
}
