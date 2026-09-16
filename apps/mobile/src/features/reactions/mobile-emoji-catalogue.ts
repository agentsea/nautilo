import emojiGroups from "unicode-emoji-json/data-by-group.json";

export type MobileEmoji = {
  readonly emoji: string;
  readonly name: string;
  readonly slug: string;
  readonly category: string;
  readonly categorySlug: string;
};

export type MobileEmojiCategory = {
  readonly name: string;
  readonly slug: string;
  readonly icon: string;
};

const CATEGORY_ICONS: Readonly<Record<string, string>> = {
  smileys_emotion: "😀",
  people_body: "👋",
  animals_nature: "🐻",
  food_drink: "🍕",
  travel_places: "🚗",
  activities: "⚽",
  objects: "💡",
  symbols: "❤️",
  flags: "🏳️",
};

export const MOBILE_EMOJI_CATEGORIES: readonly MobileEmojiCategory[] = emojiGroups.map((group) => ({
  name: group.name,
  slug: group.slug,
  icon: CATEGORY_ICONS[group.slug] ?? "•",
}));

export const MOBILE_EMOJI_CATALOGUE: readonly MobileEmoji[] = emojiGroups.flatMap((group) =>
  group.emojis.map((entry) => ({
    emoji: entry.emoji,
    name: entry.name,
    slug: entry.slug,
    category: group.name,
    categorySlug: group.slug,
  })),
);

export function filterMobileEmoji(
  query: string,
  categorySlug: string | null,
): readonly MobileEmoji[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return MOBILE_EMOJI_CATALOGUE.filter((entry) => {
    if (categorySlug != null && entry.categorySlug !== categorySlug) return false;
    if (!normalizedQuery) return true;
    return `${entry.emoji} ${entry.name} ${entry.slug.replaceAll("_", " ")}`.includes(normalizedQuery);
  });
}

export function recordRecentEmoji(current: readonly string[], emoji: string): readonly string[] {
  return [emoji, ...current.filter((entry) => entry !== emoji)].slice(0, 24);
}
