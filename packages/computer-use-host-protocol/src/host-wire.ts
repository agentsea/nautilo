/**
 * Browser-safe Desktop-to-Host envelope contract.
 *
 * The byte transport and PNG implementation are intentionally available only
 * from `@nautilo/computer-use-host-protocol/node`.
 */
export {
  COMPUTER_USE_HOST_CONTROL_MAX_BYTES,
  COMPUTER_USE_HOST_PNG_MAX_BYTES,
  COMPUTER_USE_HOST_PROTOCOL_MAJOR,
  COMPUTER_USE_HOST_PROTOCOL_MINOR,
  ComputerUseHostProtocolError,
  ComputerUseHostResultGate,
  assertComputerUseHostAttachmentMatchesResult,
  canonicalizeComputerUseJson,
  parseComputerUseHostAttachmentMetadata,
  parseComputerUseHostAuthorityScope,
  parseComputerUseHostContract,
  parseComputerUseHostControlMessage,
  parseComputerUseHostGenerationFence,
  stringifyCanonicalComputerUseJson,
  type ComputerUseHostAttachmentMetadata,
  type ComputerUseHostAuthorityScope,
  type ComputerUseHostCancel,
  type ComputerUseAttachmentClass,
  type ComputerUseAuthorityClass,
  type ComputerUseDisclosureClass,
  type ComputerUseEffectClass,
  type ComputerUseHostContract,
  type ComputerUseHostControlMessage,
  type ComputerUseHostGenerationFence,
  type ComputerUseHostProtocolVersion,
  type ComputerUseHostReady,
  type ComputerUseHostRequest,
  type ComputerUseHostResult,
  type ComputerUseHostResultExpectation,
  type ComputerUseHostResultMessage,
  type ComputerUseReplayClass,
  type ComputerUseJson,
  type ComputerUseSettlement,
} from "./protocol.js";
