import { isApprovedMindSwapperDestination, normalizeMindSwapperBaseUrl } from "@nautilo/config-guard";
import type { PersonalProviderId } from "@nautilo/db";
import { GATEWAY_BASE_URL_ENV, gatewayKeyDestination } from "@nautilo/types";

export {
  getApprovedMindSwapperDestinations,
  isApprovedMindSwapperDestination,
  normalizeMindSwapperBaseUrl,
} from "@nautilo/config-guard";

type PersonalProviderDestinationRecord = Readonly<{
  provider: PersonalProviderId;
  destination: string | null;
}>;

/** The fixed administrator-configured destination used by personal Gateway keys. */
export function currentPersonalGatewayDestination(): string | null {
  return gatewayKeyDestination(process.env[GATEWAY_BASE_URL_ENV]);
}

/**
 * Personal Gateway credentials are valid only for the exact normalized base
 * path where they were enrolled. Legacy unbound rows require re-enrollment.
 */
export function validatePersonalGatewayDestination(
  record: PersonalProviderDestinationRecord,
): boolean {
  if (record.provider !== "gateway") return true;
  const current = currentPersonalGatewayDestination();
  return current !== null && record.destination === current;
}

export function validatePersonalProviderDestination(record: PersonalProviderDestinationRecord): boolean {
  if (record.provider !== "mindswapper") return validatePersonalGatewayDestination(record);
  return record.destination !== null
    && normalizeMindSwapperBaseUrl(record.destination) === record.destination
    && isApprovedMindSwapperDestination(record.destination);
}
