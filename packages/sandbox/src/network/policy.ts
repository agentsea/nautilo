/**
 * Network egress policy model (D103).
 *
 * This is deliberately small: it is NOT Kubernetes, a service mesh, or
 * a cloud firewall model. It captures the three product-level egress
 * modes Nautilo needs and the allow-rule shapes a local proxy/OS sandbox
 * can enforce.
 */

export type NetworkPolicy =
  | { readonly mode: "host" }
  | { readonly mode: "isolated" }
  | {
      readonly mode: "proxy-allowlist";
      readonly allow: readonly NetworkAllowRule[];
      /** Default port for domain/wildcard rules that omit ports. */
      readonly defaultPort?: typeof DEFAULT_NETWORK_PORT;
    };

export type NetworkAllowRule =
  | {
      readonly type: "domain";
      readonly host: string;
      readonly ports?: readonly number[];
    }
  | {
      readonly type: "wildcard";
      /** Suffix without leading "*."; e.g. "github.com". */
      readonly suffix: string;
      readonly ports?: readonly number[];
    }
  | {
      readonly type: "cidr";
      readonly cidr: string;
      readonly ports?: readonly number[];
    };

export interface NetworkDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly matchedRule?: NetworkAllowRule;
}

export interface DeniedNetworkDestination {
  readonly host: string;
  readonly port: number;
  readonly reason: string;
}

export const DEFAULT_NETWORK_PORT = 443;

export const HOST_NETWORK_POLICY: NetworkPolicy = { mode: "host" };
export const ISOLATED_NETWORK_POLICY: NetworkPolicy = { mode: "isolated" };
