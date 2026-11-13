/** A fixed, content-free explanation for a rejected external Room resource. */
export class ExternalRoomTextOnlyError extends Error {
  readonly userMessage =
    "This connected conversation supports text only. Remove the attachment or document reference to send your message, or use a regular Nautilo chat to work with it.";

  constructor() {
    super("external_room_text_only");
    this.name = "ExternalRoomTextOnlyError";
  }
}
