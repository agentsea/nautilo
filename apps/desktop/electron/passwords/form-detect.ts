/**
 * D403 (ISSUE-D403) Phase 1 — pure login-form detection heuristics.
 *
 * This module is DOM-FREE and unit-testable. It takes an array of plain field
 * descriptors (built by the guest preload from the live DOM) and decides which
 * field is the password, which is the username/identifier, and whether the set
 * is confident enough to be treated as a login form.
 *
 * ALL of the login-form heuristics live here as pure logic. The guest preload
 * (`guest-preload.ts`) is responsible only for the DOM glue: enumerating input
 * elements, normalizing them into `FieldDescriptor`s, computing live rects, and
 * assembling the `DetectedLoginForm` from the `DetectionResult` this returns.
 *
 * SECURITY (R6): this file never touches credential values — it only classifies
 * field *shapes*. It handles no plaintext and exposes nothing to the page.
 */

/**
 * A plain, DOM-free description of a single form field. The guest preload
 * normalizes each live `<input>` into one of these (absent attributes become
 * empty strings, `type` is lowercased) so this module stays pure and testable.
 */
export interface FieldDescriptor {
  /** Stable-per-page ref the guest can later use to locate the element. */
  fieldId: string;
  /** Lowercased tag name, e.g. `"input"`. */
  tag: string;
  /** Lowercased `type` attribute; `""` is treated as `"text"`. */
  type: string;
  /** Lowercased `autocomplete` attribute (`""` if absent). */
  autocomplete: string;
  /** `name` attribute (`""` if absent). */
  name: string;
  /** `id` attribute (`""` if absent). */
  id: string;
  /** Whether the field is currently rendered/visible (has layout box). */
  isVisible: boolean;
}

/**
 * The DOM-free core of a `DetectedLoginForm`: which fields matter and whether
 * this is a login form at all. The guest preload adds the live pieces the DOM
 * owns (`formId`, `frameOrigin`, `rects`) to produce the full `DetectedLoginForm`.
 */
export interface DetectionResult {
  /** True when a usable (visible) password field was found. */
  isLoginForm: boolean;
  /** `fieldId` of the chosen password field, when this is a login form. */
  passwordFieldId?: string;
  /** `fieldId` of the chosen username/identifier field, when one is found. */
  usernameFieldId?: string;
}

/** Name/id substrings that strongly hint a username/identifier field. */
const USERNAME_HINT = /(user|usr|login|email|e-?mail|account|ident|uid|nick|handle)/i;

/** Input `type`s eligible to be the username/identifier field. */
const USERNAME_TYPES = new Set(["text", "email", "tel", "url", ""]);

/** Normalize a raw type: an empty type attribute behaves as `"text"`. */
function normalizeType(type: string): string {
  return type === "" ? "text" : type;
}

/**
 * Attribute-only score for a username/identifier candidate. Positional signals
 * (adjacency to the password field) are applied separately during selection so
 * they act purely as a tie-breaker and never override a strong attribute match.
 */
function usernameAttributeScore(field: FieldDescriptor): number {
  let score = 0;

  const autocomplete = field.autocomplete.toLowerCase();
  if (autocomplete === "username") score += 6;
  else if (autocomplete === "email") score += 5;

  const type = normalizeType(field.type);
  if (type === "email") score += 4;
  else if (type === "tel" || type === "url") score += 1;

  if (USERNAME_HINT.test(field.name) || USERNAME_HINT.test(field.id)) {
    score += 3;
  }

  return score;
}

/**
 * Proximity rank of a candidate relative to the password field. Lower is
 * better: fields immediately *preceding* the password rank best (login forms
 * put the identifier above the password), following fields are penalized.
 */
function proximityRank(candidateIndex: number, passwordIndex: number): number {
  if (candidateIndex < passwordIndex) {
    return passwordIndex - candidateIndex;
  }
  // Following the password field is unusual for a login identifier — rank it
  // strictly worse than any preceding field.
  return 1000 + (candidateIndex - passwordIndex);
}

function isUsernameEligible(field: FieldDescriptor): boolean {
  if (field.tag !== "input") return false;
  if (!field.isVisible) return false;
  return USERNAME_TYPES.has(field.type);
}

/**
 * Detect a login form from a set of field descriptors (in DOM order).
 *
 * Rules:
 *  - The password field is the first *visible* `type=password` input. Its
 *    presence is what makes the set a login form (so a change-password page
 *    with only password fields still detects the password field).
 *  - The username/identifier field is chosen by attribute heuristics
 *    (`autocomplete`, `type=email`, name/id hints), with adjacency to the
 *    password field as a tie-breaker so the field next to the password wins
 *    among otherwise-equal candidates. It may be absent (password-only pages).
 */
export function detectLoginForm(fields: FieldDescriptor[]): DetectionResult {
  const passwordIndex = fields.findIndex(
    (f) => f.tag === "input" && normalizeType(f.type) === "password" && f.isVisible,
  );

  if (passwordIndex === -1) {
    return { isLoginForm: false };
  }

  const passwordField = fields[passwordIndex];
  if (passwordField === undefined) {
    return { isLoginForm: false };
  }

  const result: DetectionResult = {
    isLoginForm: true,
    passwordFieldId: passwordField.fieldId,
  };

  let bestIndex = -1;
  let bestScore = -1;
  let bestRank = Number.POSITIVE_INFINITY;

  for (let i = 0; i < fields.length; i++) {
    if (i === passwordIndex) continue;
    const field = fields[i];
    if (field === undefined) continue;
    if (!isUsernameEligible(field)) continue;

    const score = usernameAttributeScore(field);
    const rank = proximityRank(i, passwordIndex);

    const better =
      score > bestScore || (score === bestScore && rank < bestRank);
    if (better) {
      bestIndex = i;
      bestScore = score;
      bestRank = rank;
    }
  }

  if (bestIndex !== -1) {
    const usernameField = fields[bestIndex];
    if (usernameField !== undefined) {
      result.usernameFieldId = usernameField.fieldId;
    }
  }

  return result;
}
