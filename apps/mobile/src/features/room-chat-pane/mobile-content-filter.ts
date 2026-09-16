export const MOBILE_CONTENT_FILTER_NOTICE =
  "This can't be posted because it may violate the Community Rules. Edit it and try again.";

export type MobilePostingAdmission = "allowed" | "blocked";

export type MobileHumanPosting = {
  text: string;
  attachmentFilenames?: readonly string[];
};

/**
 * Keep the store-minimum admission check predictable and entirely on-device.
 * Punctuation and symbols become boundaries rather than disappearing so they
 * cannot accidentally join otherwise separate words.
 */
export function normalizeMobilePostingText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const PROTECTED_GROUP = String.raw`(?:black people|asian people|jewish people|jews?|muslim people|muslims?|christian people|christians?|gay people|lesbians?|trans(?:gender)? people|disabled people)`;

const BLOCKED_PATTERNS: readonly RegExp[] = [
  // Unmistakable sexual exploitation of children or minors.
  /\b(?:child|children|minor|minors|underage)\s+(?:porn(?:ography)?|nudes?|sexual\s+(?:content|images?|videos?))\b/u,
  /\b(?:porn(?:ography)?|nudes?|sexual\s+(?:content|images?|videos?))\s+(?:of\s+)?(?:a\s+)?(?:child|children|minor|minors|underage)\b/u,

  // Direct, targeted violent threats and severe targeted harassment.
  /\b(?:i\s+(?:will|ll|am\s+going\s+to|m\s+going\s+to)|we\s+(?:will|ll|are\s+going\s+to|re\s+going\s+to))\s+(?:kill|murder|shoot|stab)\s+(?:you|him|her|them)\b/u,
  /\b(?:go\s+)?kill\s+yourself\b/u,
  /\b(?:i\s+hope\s+you|you\s+should)\s+die\b/u,

  // Explicit calls for violence against, or dehumanization of, protected groups.
  new RegExp(String.raw`\b(?:kill|murder|exterminate|eradicate)\s+(?:all\s+)?(?:the\s+)?${PROTECTED_GROUP}\b`, "u"),
  new RegExp(String.raw`\b(?:all\s+)?${PROTECTED_GROUP}\s+(?:are|is)\s+(?:vermin|subhuman|filth)\b`, "u"),
];

function containsBlockedContent(value: string): boolean {
  const normalized = normalizeMobilePostingText(value);
  return normalized.length > 0 && BLOCKED_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Returns only the local admission decision; it performs no I/O or logging. */
export function assessMobileHumanPosting({
  text,
  attachmentFilenames = [],
}: MobileHumanPosting): MobilePostingAdmission {
  if (containsBlockedContent(text)) return "blocked";
  return attachmentFilenames.some(containsBlockedContent) ? "blocked" : "allowed";
}
