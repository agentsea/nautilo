/** Only known native error codes become user copy; never display provider paths or arbitrary exceptions. */
export function nativeSaveFailureCopy(error: unknown): string {
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : null;
  switch (code) {
    case "ERR_MEDIA_PERMISSION": return "Photo library access was not granted. You can allow adding photos in system settings, or use Save file instead.";
    case "ERR_MEDIA_TYPE": return "Your photo library cannot save this format. Use Save file to keep the original unchanged.";
    case "ERR_MEDIA_INVALID": return "This original is not a valid photo or video for your photo library. Use Save file to keep the original unchanged.";
    case "ERR_MEDIA_SOURCE": return "The prepared image or video is no longer available. Try again or use Save file.";
    case "ERR_MEDIA_SAVE": return "The photo library could not save this file. Check available storage, or use Save file instead.";
    case "ERR_MEDIA_CANCELLED_RESIDUAL": return "Saving was cancelled, but a partial item may remain in your photo library. Check the library before trying again.";
    case "ERR_MEDIA_SAVE_RESIDUAL": return "The file could not be saved completely. A partial item may remain in your photo library.";
    case "ERR_EXPORT_CANCELLED_RESIDUAL": return "Save was cancelled, but an empty or partial file may remain in the selected location. Check that location before trying again.";
    case "ERR_EXPORT_CANCELLED_CACHE_RESIDUAL": return "Save was cancelled, but a temporary app copy could not be removed.";
    case "ERR_EXPORT_WRITE_RESIDUAL": return "The file could not be saved completely. A partial file may remain in the selected location.";
    case "ERR_EXPORT_SAVED_RESIDUAL": return "Saved, but a temporary app copy could not be removed.";
    case "ERR_EXPORT_WRITE": return "The file could not be saved. Check available storage or choose another destination.";
    case "ERR_EXPORT_INTERRUPTED": return "Saving was interrupted. Check the selected destination before trying again.";
    case "ERR_EXPORT_BUSY": return "Another file is still being saved. Finish or close its save dialog, then try again.";
    case "ERR_EXPORT_ACTIVITY": case "ERR_EXPORT_DESTINATION": return "The save dialog is unavailable right now. Return to Nautilo and try again.";
    case "ERR_EXPORT_SOURCE": return "The prepared original is no longer available. Try saving again.";
    case "ERR_EXPORT_TEMP_CLEANUP": case "ERR_EXPORT_CACHE_CLEANUP": return "The file was not saved, and a temporary app copy could not be removed.";
    case "ERR_EXPORT_PREPARE": return "The file could not be prepared. Check available storage and try again.";
    case "ERR_EXPORT_FILENAME": case "ERR_EXPORT_TYPE": return "This file's name or type cannot be used by the destination. The original has not been changed.";
    default: return "Could not save the file. Check storage or choose another destination, then try again.";
  }
}
