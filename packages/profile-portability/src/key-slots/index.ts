export type { KeySlotV1, RecoverySlot, KeychainSlot, KeySlotKind } from "./types";

export {
  validateKeySlot,
  validateKeySlots,
  isRecoverySlot,
  isKeychainSlot,
  isKeySlotV1,
} from "./validate";
