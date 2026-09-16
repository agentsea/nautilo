import ipaddr from "ipaddr.js";

/** Returns true only for globally routable unicast IPv4/IPv6 addresses. */
export function isPublicRoutableAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6") {
      const ipv6 = parsed as ipaddr.IPv6;
      const normalized = ipv6.isIPv4MappedAddress()
        ? ipv6.toIPv4Address()
        : ipv6;
      return normalized.range() === "unicast";
    }
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}
