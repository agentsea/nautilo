/** Node-only host-wire transport. The package root intentionally exports no Node builtins. */
export {
  ControlFrameDecoder,
  AttachmentFrameDecoder,
  decodeControlFrame,
  encodeControlFrame,
  encodePngAttachmentFrame,
  parsePngAttachment,
  type ComputerUseHostPngAttachment,
} from "./node-wire.js";
