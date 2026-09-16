import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import sharp from "sharp";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

const ALLOWED_ELEMENTS = new Set(["svg", "defs", "mask", "g", "use", "path", "rect", "image"]);
const COMMON_ATTRIBUTES = new Set([
  "id",
  "fill",
  "mask",
  "opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-width",
  "transform",
]);
const ELEMENT_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  svg: new Set(["xmlns", "width", "height", "viewBox"]),
  defs: new Set(),
  mask: new Set(["id", "maskUnits", "x", "y", "width", "height"]),
  g: COMMON_ATTRIBUTES,
  use: new Set(["href", "transform"]),
  path: new Set([...COMMON_ATTRIBUTES, "d"]),
  rect: new Set([...COMMON_ATTRIBUTES, "x", "y", "width", "height", "rx", "ry"]),
  image: new Set(["href", "x", "y", "width", "height", "preserveAspectRatio"]),
};

const NUMBER_SOURCE = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?`;
const NUMBER_RE = new RegExp(`^${NUMBER_SOURCE}$`);
const PATH_TOKEN_RE = new RegExp(`[MLQCZ]|${NUMBER_SOURCE}`, "g");
const TRANSFORM_RE = new RegExp(
  String.raw`(?:matrix|translate|scale|rotate|skewX|skewY)\(\s*${NUMBER_SOURCE}(?:[\s,]+${NUMBER_SOURCE})*\s*\)`,
  "gy",
);
const SAFE_ID_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const SAFE_HEX_COLOR_RE = /^#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f](?:[0-9A-Fa-f]{2}(?:[0-9A-Fa-f]{2})?)?)?$/;
const CSS_NAMED_COLORS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue " +
    "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson " +
    "cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta " +
    "darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray " +
    "darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick " +
    "floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey " +
    "honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon " +
    "lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink " +
    "lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime " +
    "limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
    "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose " +
    "moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen " +
    "paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red " +
    "rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue " +
    "slategray slategrey snow springgreen steelblue tan teal thistle tomato transparent turquoise violet " +
    "wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);

type SvgElement = Element;

export type ResourceFreeSvgValidationOptions = Readonly<{
  /** Host-owned proof that an image data URL was produced by asset resolution. */
  isHostResolvedPngDataUrl?: (href: string) => boolean;
}>;

export type SvgRasterResult =
  | { ok: true; bytes: Buffer; width: number; height: number }
  | { ok: false; code: "INVALID_SVG" | "RASTER_FAILED"; message: string };

function invalid(message: string): never {
  throw new Error(message);
}

function finiteNumber(value: string, label: string): number {
  if (!NUMBER_RE.test(value.trim())) invalid(`${label} must be a finite number.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) invalid(`${label} must be a finite number.`);
  return parsed;
}

function validateDimension(value: string, label: string, positive: boolean): void {
  const parsed = finiteNumber(value, label);
  if (positive ? parsed <= 0 : parsed < 0) {
    invalid(`${label} must be ${positive ? "positive" : "non-negative"}.`);
  }
}

function validateOpacity(value: string): void {
  const parsed = finiteNumber(value, "opacity");
  if (parsed < 0 || parsed > 1) invalid("opacity must be between 0 and 1.");
}

function parseCssChannel(value: string): boolean {
  const part = value.trim();
  if (part.endsWith("%")) {
    const number = finiteNumber(part.slice(0, -1), "color channel");
    return number >= 0 && number <= 100;
  }
  const number = finiteNumber(part, "color channel");
  return number >= 0 && number <= 255;
}

function parseCssAlpha(value: string): boolean {
  const part = value.trim();
  if (part.endsWith("%")) {
    const number = finiteNumber(part.slice(0, -1), "alpha channel");
    return number >= 0 && number <= 100;
  }
  const number = finiteNumber(part, "alpha channel");
  return number >= 0 && number <= 1;
}

function validatePaint(value: string, attribute: string): void {
  const trimmed = value.trim();
  const keyword = trimmed.toLowerCase();
  if (keyword === "none" || SAFE_HEX_COLOR_RE.test(trimmed) || CSS_NAMED_COLORS.has(keyword)) {
    return;
  }
  const functional = /^(rgb|rgba)\((.*)\)$/.exec(trimmed);
  if (functional) {
    const parts = functional[2]!.split(",");
    const expected = functional[1] === "rgb" ? 3 : 4;
    if (
      parts.length === expected &&
      parts.slice(0, 3).every(parseCssChannel) &&
      (expected === 3 || parseCssAlpha(parts[3]!))
    ) {
      return;
    }
  }
  invalid(`${attribute} contains an unsupported paint value.`);
}

function validateNumberList(value: string, label: string, nonNegative: boolean): void {
  const parts = value.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) invalid(`${label} must contain at least one number.`);
  for (const part of parts) {
    const number = finiteNumber(part, label);
    if (nonNegative && number < 0) invalid(`${label} must contain only non-negative numbers.`);
  }
}

function validateTransform(value: string): void {
  const trimmed = value.trim();
  if (!trimmed) invalid("transform must not be empty.");
  let offset = 0;
  while (offset < trimmed.length) {
    while (offset < trimmed.length && /[\s,]/.test(trimmed[offset]!)) offset += 1;
    if (offset === trimmed.length) return;
    TRANSFORM_RE.lastIndex = offset;
    const match = TRANSFORM_RE.exec(trimmed);
    if (!match || match.index !== offset) invalid("transform contains unsupported syntax.");
    const matchedTransform = match[0];
    const name = matchedTransform.slice(0, matchedTransform.indexOf("("));
    const values = matchedTransform
      .slice(matchedTransform.indexOf("(") + 1, -1)
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((part) => finiteNumber(part, "transform"));
    const validArity =
      (name === "matrix" && values.length === 6) ||
      ((name === "translate" || name === "scale") && (values.length === 1 || values.length === 2)) ||
      (name === "rotate" && (values.length === 1 || values.length === 3)) ||
      ((name === "skewX" || name === "skewY") && values.length === 1);
    if (!validArity) invalid(`${name} transform has the wrong number of arguments.`);
    offset = TRANSFORM_RE.lastIndex;
  }
}

function validatePathData(value: string): void {
  const compact = value.replace(/[\s,]+/g, "");
  if (!compact) invalid("path d must not be empty.");
  const tokens = value.match(PATH_TOKEN_RE) ?? [];
  if (tokens.join("") !== compact) invalid("path d contains unsupported syntax.");
  const arity: Readonly<Record<string, number>> = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
  for (let index = 0; index < tokens.length;) {
    const command = tokens[index++]!;
    const count = arity[command];
    if (count === undefined) invalid(`path d command ${command} is unsupported.`);
    for (let i = 0; i < count; i += 1) {
      const token = tokens[index++];
      if (token === undefined || !NUMBER_RE.test(token)) {
        invalid(`path d command ${command} has incomplete coordinates.`);
      }
      finiteNumber(token, "path coordinate");
    }
    if (index < tokens.length && !Object.hasOwn(arity, tokens[index]!)) {
      invalid(`path d command ${command} has excess coordinates.`);
    }
  }
}

function elementChildren(element: SvgElement): SvgElement[] {
  const children: SvgElement[] = [];
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) {
      children.push(child as SvgElement);
      continue;
    }
    if (child.nodeType === 3 && !(child.nodeValue ?? "").trim()) continue;
    invalid("SVG contains unsupported non-element content.");
  }
  return children;
}

function validateAttribute(
  element: SvgElement,
  name: string,
  value: string,
  options: ResourceFreeSvgValidationOptions,
): string | null {
  const tag = element.tagName;
  if (name === "xmlns") {
    if (tag !== "svg" || value !== SVG_NAMESPACE) invalid("SVG namespace must be canonical.");
    return null;
  }
  if (name === "id") {
    if (!SAFE_ID_RE.test(value)) invalid("SVG id contains unsupported characters.");
    return null;
  }
  if (name === "fill" || name === "stroke") {
    validatePaint(value, name);
    return null;
  }
  if (name === "opacity") {
    validateOpacity(value);
    return null;
  }
  if (name === "stroke-width" || name === "rx" || name === "ry") {
    validateDimension(value, name, false);
    return null;
  }
  if (name === "x" || name === "y") {
    finiteNumber(value, name);
    return null;
  }
  if (name === "width" || name === "height") {
    validateDimension(value, name, tag === "svg");
    return null;
  }
  if (name === "stroke-dasharray") {
    validateNumberList(value, name, true);
    return null;
  }
  if (name === "stroke-linecap") {
    if (value !== "butt" && value !== "round" && value !== "square") invalid("stroke-linecap is unsupported.");
    return null;
  }
  if (name === "stroke-linejoin") {
    if (value !== "miter" && value !== "round" && value !== "bevel") invalid("stroke-linejoin is unsupported.");
    return null;
  }
  if (name === "transform") {
    validateTransform(value);
    return null;
  }
  if (name === "d") {
    validatePathData(value);
    return null;
  }
  if (name === "maskUnits") {
    if (value !== "userSpaceOnUse") invalid("maskUnits must be userSpaceOnUse.");
    return null;
  }
  if (name === "viewBox") {
    const parts = value.trim().split(/[\s,]+/).filter(Boolean);
    if (parts.length !== 4) invalid("viewBox must contain four numbers.");
    const numbers = parts.map((part) => finiteNumber(part, "viewBox"));
    if (numbers[2]! <= 0 || numbers[3]! <= 0) invalid("viewBox width and height must be positive.");
    return null;
  }
  if (name === "href") {
    if (tag === "image") {
      if (
        !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(value) ||
        !options.isHostResolvedPngDataUrl?.(value)
      ) {
        invalid("image href must be a host-resolved PNG data URL.");
      }
      return null;
    }
    const match = /^#([A-Za-z_][A-Za-z0-9_.-]*)$/.exec(value);
    if (!match) invalid("use href must be a local fragment reference.");
    return match[1]!;
  }
  if (name === "preserveAspectRatio") {
    if (tag !== "image" || value !== "xMidYMid meet") {
      invalid("preserveAspectRatio must be xMidYMid meet.");
    }
    return null;
  }
  if (name === "mask") {
    const match = /^url\(#([A-Za-z_][A-Za-z0-9_.-]*)\)$/.exec(value);
    if (!match) invalid("mask must be a local fragment reference.");
    return match[1]!;
  }
  invalid(`SVG attribute ${name} is unsupported.`);
}

/** Validate the exact resource-free subset emitted by Design's canonical PNG renderer. */
export function validateResourceFreeSvg(
  svg: string,
  options: ResourceFreeSvgValidationOptions = {},
): void {
  if (/<\s*!\s*(?:DOCTYPE|ENTITY)|<\?/iu.test(svg)) {
    invalid("SVG declarations, entities, and processing instructions are unsupported.");
  }
  let document: Document;
  try {
    document = new DOMParser({
      locator: false,
      onError(_level, message) {
        throw new Error(message);
      },
    }).parseFromString(svg, "image/svg+xml");
  } catch (error) {
    invalid(`SVG XML is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = document.documentElement;
  if (!root || root.tagName !== "svg" || root.namespaceURI !== SVG_NAMESPACE) {
    invalid("SVG must have one canonical svg root element.");
  }
  for (let child = document.firstChild; child; child = child.nextSibling) {
    if (child === root) continue;
    if (child.nodeType === 3 && !(child.nodeValue ?? "").trim()) continue;
    invalid("SVG must contain only one root element.");
  }

  const ids = new Map<string, SvgElement>();
  const references = new Map<string, Set<string>>();
  const referenceUses: Array<{ kind: "mask" | "use"; target: string }> = [];
  const visit = (element: SvgElement, owningId: string | null): void => {
    if (element.namespaceURI !== SVG_NAMESPACE || !ALLOWED_ELEMENTS.has(element.tagName)) {
      invalid(`SVG element ${element.tagName} is unsupported.`);
    }
    const allowed = ELEMENT_ATTRIBUTES[element.tagName]!;
    let elementId: string | null = null;
    const localReferences: string[] = [];
    for (let i = 0; i < element.attributes.length; i += 1) {
      const attribute = element.attributes.item(i)!;
      const name = attribute.name;
      if (
        !allowed.has(name) ||
        (attribute.namespaceURI && !(name === "xmlns" && attribute.namespaceURI === XMLNS_NAMESPACE)) ||
        name.includes(":")
      ) {
        invalid(`SVG attribute ${name} is unsupported on ${element.tagName}.`);
      }
      const reference = validateAttribute(element, name, attribute.value, options);
      if (name === "id") elementId = attribute.value;
      if (reference) {
        localReferences.push(reference);
        referenceUses.push({ kind: name === "mask" ? "mask" : "use", target: reference });
      }
    }
    if (element.tagName === "svg") {
      if (!element.hasAttribute("xmlns") || !element.hasAttribute("width") || !element.hasAttribute("height")) {
        invalid("SVG root requires canonical xmlns, width, and height attributes.");
      }
    }
    if (element.tagName === "path" && !element.hasAttribute("d")) invalid("path requires d.");
    if (element.tagName === "use" && !element.hasAttribute("href")) invalid("use requires href.");
    if (element.tagName === "image") {
      for (const name of ["href", "x", "y", "width", "height", "preserveAspectRatio"] as const) {
        if (!element.hasAttribute(name)) invalid(`image requires ${name}.`);
      }
    }
    if (element.tagName === "rect") {
      for (const name of ["x", "y", "width", "height"] as const) {
        if (!element.hasAttribute(name)) invalid(`rect requires ${name}.`);
      }
    }
    if (element.tagName === "mask" && element.getAttribute("maskUnits") !== "userSpaceOnUse") {
      invalid("mask requires maskUnits=userSpaceOnUse.");
    }
    if (element.tagName === "mask") {
      for (const name of ["id", "x", "y", "width", "height"] as const) {
        if (!element.hasAttribute(name)) invalid(`mask requires ${name}.`);
      }
    }
    if (elementId) {
      if (ids.has(elementId)) invalid(`SVG id ${elementId} is duplicated.`);
      ids.set(elementId, element);
      references.set(elementId, new Set());
      if (owningId && owningId !== elementId) {
        const ownerReferences = references.get(owningId) ?? new Set<string>();
        ownerReferences.add(elementId);
        references.set(owningId, ownerReferences);
      }
    }
    const owner = elementId ?? owningId;
    if (owner) {
      const owned = references.get(owner) ?? new Set<string>();
      for (const reference of localReferences) owned.add(reference);
      references.set(owner, owned);
    }
    const children = elementChildren(element);
    if ((element.tagName === "use" || element.tagName === "path" || element.tagName === "rect" || element.tagName === "image") && children.length > 0) {
      invalid(`${element.tagName} must not contain child elements.`);
    }
    for (const child of children) visit(child, owner);
  };
  visit(root, null);

  for (const reference of referenceUses) {
    const targetElement = ids.get(reference.target);
    if (!targetElement) invalid(`SVG reference #${reference.target} is missing.`);
    if (reference.kind === "mask" && targetElement.tagName !== "mask") {
      invalid(`SVG mask reference #${reference.target} does not target a mask.`);
    }
    if (reference.kind === "use" && targetElement.tagName !== "g") {
      invalid(`SVG use reference #${reference.target} does not target a group.`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): void => {
    if (visiting.has(id)) invalid(`SVG reference cycle includes #${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of references.get(id) ?? []) walk(target);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids.keys()) walk(id);
}

/** Rasterize validated SVG without hidden pixel truncation or fallback rendering. */
export async function rasterizeResourceFreeSvg(
  svg: string,
  options: ResourceFreeSvgValidationOptions = {},
): Promise<SvgRasterResult> {
  try {
    validateResourceFreeSvg(svg, options);
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_SVG",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const rendered = await sharp(Buffer.from(svg, "utf8"), {
      failOn: "warning",
      limitInputPixels: false,
      unlimited: false,
    })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (rendered.info.format !== "png" || rendered.info.width < 1 || rendered.info.height < 1) {
      return { ok: false, code: "RASTER_FAILED", message: "Sharp returned invalid PNG metadata." };
    }
    return {
      ok: true,
      bytes: rendered.data,
      width: rendered.info.width,
      height: rendered.info.height,
    };
  } catch (error) {
    return {
      ok: false,
      code: "RASTER_FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
