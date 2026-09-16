/** True when the request IP is loopback (IPv4 or IPv6). */
export function isLocalhostIp(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
