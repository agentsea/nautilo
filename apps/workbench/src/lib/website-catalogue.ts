/**
 * Browser-safe, versioned presets for the personal website connection journey.
 * These entries are discovery data only: they never describe an account or its
 * connection state. Server-owned Connected Web Accounts will be projected
 * separately once that lifecycle exists.
 */
export type WebsiteCategory = "productivity" | "social" | "commerce" | "travel";

export type WebsiteCatalogueEntry = Readonly<{
  id: string;
  displayName: string;
  startUrl: string;
  relatedDomains: readonly string[];
  category: WebsiteCategory;
  icon: string;
  searchTerms: readonly string[];
}>;

export const WEBSITE_CATALOGUE: readonly WebsiteCatalogueEntry[] = [
  { id: "google", displayName: "Google", startUrl: "https://www.google.com", relatedDomains: ["google.com", "accounts.google.com"], category: "productivity", icon: "G", searchTerms: ["search", "workspace"] },
  { id: "google-maps", displayName: "Google Maps", startUrl: "https://maps.google.com", relatedDomains: ["maps.google.com", "google.com"], category: "productivity", icon: "🗺", searchTerms: ["maps", "places", "directions"] },
  { id: "notion", displayName: "Notion", startUrl: "https://www.notion.so", relatedDomains: ["notion.so"], category: "productivity", icon: "N", searchTerms: ["notes", "docs", "workspace"] },
  { id: "slack", displayName: "Slack", startUrl: "https://slack.com", relatedDomains: ["slack.com"], category: "productivity", icon: "S", searchTerms: ["messages", "chat", "workspace"] },
  { id: "linkedin", displayName: "LinkedIn", startUrl: "https://www.linkedin.com", relatedDomains: ["linkedin.com"], category: "social", icon: "in", searchTerms: ["network", "jobs", "professional"] },
  { id: "x", displayName: "X", startUrl: "https://x.com", relatedDomains: ["x.com", "twitter.com"], category: "social", icon: "𝕏", searchTerms: ["twitter", "social", "posts"] },
  { id: "facebook", displayName: "Facebook", startUrl: "https://www.facebook.com", relatedDomains: ["facebook.com"], category: "social", icon: "f", searchTerms: ["social", "friends", "meta"] },
  { id: "instagram", displayName: "Instagram", startUrl: "https://www.instagram.com", relatedDomains: ["instagram.com"], category: "social", icon: "◎", searchTerms: ["social", "photos", "meta"] },
  { id: "pinterest", displayName: "Pinterest", startUrl: "https://www.pinterest.com", relatedDomains: ["pinterest.com"], category: "social", icon: "P", searchTerms: ["ideas", "pins", "images"] },
  { id: "reddit", displayName: "Reddit", startUrl: "https://www.reddit.com", relatedDomains: ["reddit.com"], category: "social", icon: "●", searchTerms: ["communities", "forums", "social"] },
  { id: "bluesky", displayName: "Bluesky", startUrl: "https://bsky.app", relatedDomains: ["bsky.app", "bsky.social"], category: "social", icon: "B", searchTerms: ["at protocol", "social", "posts"] },
  { id: "amazon", displayName: "Amazon", startUrl: "https://www.amazon.com", relatedDomains: ["amazon.com"], category: "commerce", icon: "a", searchTerms: ["shopping", "orders", "commerce"] },
  { id: "etsy", displayName: "Etsy", startUrl: "https://www.etsy.com", relatedDomains: ["etsy.com"], category: "commerce", icon: "E", searchTerms: ["shopping", "marketplace", "orders"] },
  { id: "ebay", displayName: "eBay", startUrl: "https://www.ebay.com", relatedDomains: ["ebay.com"], category: "commerce", icon: "e", searchTerms: ["shopping", "marketplace", "orders"] },
  { id: "walmart", displayName: "Walmart", startUrl: "https://www.walmart.com", relatedDomains: ["walmart.com"], category: "commerce", icon: "W", searchTerms: ["shopping", "orders", "groceries"] },
  { id: "airbnb", displayName: "Airbnb", startUrl: "https://www.airbnb.com", relatedDomains: ["airbnb.com"], category: "travel", icon: "A", searchTerms: ["stays", "travel", "bookings"] },
  { id: "booking", displayName: "Booking.com", startUrl: "https://www.booking.com", relatedDomains: ["booking.com"], category: "travel", icon: "B", searchTerms: ["stays", "travel", "reservations"] },
  { id: "tripadvisor", displayName: "Tripadvisor", startUrl: "https://www.tripadvisor.com", relatedDomains: ["tripadvisor.com"], category: "travel", icon: "T", searchTerms: ["travel", "reviews", "trips"] },
] as const;

export function searchWebsiteCatalogue(query: string): readonly WebsiteCatalogueEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return WEBSITE_CATALOGUE;
  return WEBSITE_CATALOGUE.filter((website) => [
    website.displayName,
    website.category,
    ...website.relatedDomains,
    ...website.searchTerms,
  ].join(" ").toLowerCase().includes(normalized));
}
