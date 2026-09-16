export interface PublicProductLinks {
  privacyPolicyUrl: string;
  supportContactUrl: string;
  storeSupportUrl: string;
}

export const PUBLIC_PRODUCT_LINKS = Object.freeze({
  privacyPolicyUrl: "https://nautilo.ai/privacy",
  supportContactUrl: "mailto:support@kentauros.ai",
  storeSupportUrl: "https://nautilo.ai/docs/use/mobile",
}) satisfies Readonly<PublicProductLinks>;

const PLACEHOLDER_HOSTS = new Set([
  "0.0.0.0",
  "127.0.0.1",
  "example.com",
  "localhost",
]);

function validatePublicHttpsUrl(name: string, value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) {
    return [`${name} is missing`];
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return [`${name} must use HTTPS`];
    if (url.username || url.password) return [`${name} must not contain credentials`];
    if (
      PLACEHOLDER_HOSTS.has(hostname) ||
      hostname.includes("placeholder") ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".invalid")
    ) {
      return [`${name} must use a public production host`];
    }
    return [];
  } catch {
    return [`${name} is malformed`];
  }
}

function validateSupportContactUrl(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) {
    return ["supportContactUrl is missing"];
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "mailto:") {
      return ["supportContactUrl must use mailto"];
    }
    if (url.search || url.hash || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(url.pathname)) {
      return ["supportContactUrl must contain one plain email address"];
    }
    return [];
  } catch {
    return ["supportContactUrl is malformed"];
  }
}

export function publicProductLinkErrors(
  links: Partial<PublicProductLinks>,
): string[] {
  return [
    ...validatePublicHttpsUrl("privacyPolicyUrl", links.privacyPolicyUrl),
    ...validateSupportContactUrl(links.supportContactUrl),
    ...validatePublicHttpsUrl("storeSupportUrl", links.storeSupportUrl),
  ];
}
