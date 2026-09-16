export {
  DEFAULT_NETWORK_PORT,
  HOST_NETWORK_POLICY,
  ISOLATED_NETWORK_POLICY,
  type NetworkAllowRule,
  type NetworkDecision,
  type NetworkPolicy,
} from "./policy";

export {
  evaluateNetworkEgress,
  normalizeHost,
} from "./allowlist";

export {
  createDnsResolver,
  DnsResolutionError,
  type DnsLookupFn,
  type DnsResolver,
  type DnsResolverOptions,
} from "./dns";

export { isPublicRoutableAddress } from "./address";

export {
  startNetworkProxy,
  type NetworkProxy,
  type NetworkProxyDecisionEvent,
  type NetworkProxyOptions,
} from "./proxy";
