export type {
  AttachmentBatchClassification,
  AttachmentClassification,
  AttachmentEnvelope,
  AttachmentSource,
  AttachmentZone,
} from "./envelope";
export {
  ATTACHMENT_POLICY,
  ARCHIVE_EXTENSIONS,
  AUDIO_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  EXECUTABLE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  SCRIPT_LIKE_EXTENSIONS,
  TEXT_EXTENSIONS,
} from "./policy";
export {
  COMPOSER_CHAT_ATTACHMENT_EXTENSIONS,
  extensionOfBasename,
  isComposerChatAttachmentPathAllowed,
} from "./composer-chat-extensions";
export {
  isImageMimeForModelInput,
  isPdfMimeForModelInput,
  mimeFromExtension,
  mimeFromExtensionOr,
  sniffMimeFromPathAndBytes,
} from "./mime-classification";
export {
  normalizeAcceptedChatImageMime,
  maxChatImageBase64CharLength,
} from "./chat-image-mime";
export {
  attachmentLabelUtf8ByteLength,
  attachmentLabelExceedsUtf8Policy,
  attachmentIdExceedsUtf8Policy,
  attachmentFilenameExceedsUtf8Policy,
} from "./attachment-label-utf8";
export { sanitizeAttachmentMetadataLine } from "./attachment-metadata-sanitize";
export {
  readAttachmentHeadPrefix,
  readAttachmentBytesVerifiedSize,
  type BoundedPrefixRead,
  type VerifiedAttachmentRead,
} from "./fs/attachment-path-read";
export {
  classifyAttachment,
  classifyAttachments,
  type AttachmentPathValidationResult,
  type AttachmentPathValidator,
  type AttachmentSecurityGateOptions,
} from "./security-gate";
export {
  metadataBlockForClassification,
  type AttachmentContentBlock,
  type AttachmentStubContentBlock,
  type AttachmentTextContentBlock,
} from "./content-blocks";
export {
  attachmentTextToContentBlock,
  type TextAdapterResult,
} from "./adapters/content/text";
export {
  attachmentAudioToTranscriptBlock,
  type AudioAdapterResult,
} from "./adapters/content/audio";
export type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionProviderId,
  TranscriptionResult,
} from "./transcription/provider";
export { TranscriptionProviderUnavailableError } from "./transcription/provider";
export { createConfiguredTranscriptionProvider } from "./transcription/configured-provider";
export {
  ElevenLabsTranscriptionProvider,
  ELEVENLABS_STT_MODEL,
} from "./transcription/elevenlabs";
export { GroqTranscriptionProvider, GROQ_TRANSCRIPTION_MODEL } from "./transcription/groq";
export {
  ARTIFACT_UPLOAD_ALLOWED_EXTENSIONS,
  classifyArtifactUpload,
  detectExecutableOrArchiveMagic,
  extensionOfArtifactName,
  isArtifactUploadAllowedByExtension,
} from "./artifact-upload-policy";
