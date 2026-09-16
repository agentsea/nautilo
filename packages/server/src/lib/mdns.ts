import Bonjour from "bonjour-service";

let bonjourInstance: InstanceType<typeof Bonjour> | null = null;

export interface MdnsOptions {
  port: number;
  instanceName: string;
  hostname: string;
  version: string;
}

/**
 * Announce the Nautilo server via mDNS.
 * - Service: _nautilo._tcp.local with port + TXT record (name, version)
 * - Hostname: nautilo.local (or custom) resolves to the server's LAN IP
 *
 * Call `stopMdns()` on shutdown to un-announce.
 */
export function startMdns(options: MdnsOptions): void {
  bonjourInstance = new Bonjour();

  bonjourInstance.publish({
    name: options.instanceName,
    type: "nautilo",
    port: options.port,
    host: options.hostname,
    txt: {
      name: options.instanceName,
      version: options.version,
    },
  });
}

export function stopMdns(): void {
  if (bonjourInstance) {
    bonjourInstance.unpublishAll();
    bonjourInstance.destroy();
    bonjourInstance = null;
  }
}
