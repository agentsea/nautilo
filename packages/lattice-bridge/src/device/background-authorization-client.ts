/**
 * Portable transport qualification for the legacy V1 Stenographer contract.
 * Exporting these codecs and pure cryptographic functions does not establish
 * a current-authority host adapter or activate V1 in any product surface.
 */
export {
  BACKGROUND_AUTHORIZATION_TRANSPORT_FORMAT_VERSION_V1,
  MAX_BACKGROUND_AUTHORIZATION_REQUEST_DTO_BYTES_V1,
  MAX_BACKGROUND_AUTHORIZATION_RESPONSE_DTO_BYTES_V1,
  BackgroundAuthorizationTransportError,
  decodeBackgroundAuthorizationDeviceRequestDtoV1,
  decodeBackgroundAuthorizationDeviceResponseDtoV1,
  encodeBackgroundAuthorizationDeviceRequestDtoV1,
  encodeBackgroundAuthorizationDeviceResponseDtoV1,
} from "./background-authorization-transport.ts";
export type {
  BackgroundAuthorizationDeviceFulfillmentDtoV1,
  BackgroundAuthorizationDeviceRefusal,
  BackgroundAuthorizationDeviceRefusalDtoV1,
  BackgroundAuthorizationDeviceRequestDtoV1,
  BackgroundAuthorizationDeviceResponse,
  BackgroundAuthorizationDeviceResponseDtoV1,
  BackgroundAuthorizationTransportErrorCode,
} from "./background-authorization-transport.ts";

export {
  BackgroundAuthorizationDeviceResponderError,
  fulfillProcessorBackgroundAuthorizationRequest,
} from "./background-authorization-responder.ts";
export type {
  BackgroundAuthorizationDeviceAuthority,
  BackgroundAuthorizationDeviceAuthorityContext,
  BackgroundAuthorizationDeviceFulfillment,
  BackgroundAuthorizationDeviceRequest,
  BackgroundAuthorizationDeviceResponderErrorCode,
  ResolveCurrentBackgroundAuthorizationDeviceAuthority,
} from "./background-authorization-responder.ts";

export { respondToCurrentDeviceAuthorizationV2 } from
  "../client/background/device-authorization-responder-v2.ts";
export type {
  CurrentBackgroundAuthorizationSigningAuthorityV2,
  DeviceAuthorizationResponderResultV2,
  DeviceAuthorizationResponderV2Input,
  WithCurrentBackgroundAuthorizationSigningAuthorityV2,
} from "../client/background/device-authorization-responder-v2.ts";

export {
  createBackgroundAuthorizationSweepV2,
  createCoalescedBackgroundAuthorizationSweepV2,
} from "../client/background/background-authorization-sweep-v2.ts";
export type {
  BackgroundAuthorizationSweepResultV2,
  BackgroundAuthorizationSweepV2,
  CoalescedBackgroundAuthorizationSweepV2,
  RespondToBackgroundAuthorizationRequestV2,
} from "../client/background/background-authorization-sweep-v2.ts";
