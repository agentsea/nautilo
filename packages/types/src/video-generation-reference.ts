/** Venice Seedance reference input policy, not an editor/import quota.
 * https://docs.venice.ai/guides/media/seedance-2-0#multimodal-input-limits
 * Keep the provider adapter's existing byte boundary consistent across callers.
 */
export const VENICE_REFERENCE_VIDEO_MAX_BYTES = 50 * 1024 * 1024;

export const VENICE_REFERENCE_VIDEO_SIZE_WARNING =
  "This reference video exceeds Venice’s 50 MB limit. Use a shorter or smaller copy for generation. You can still use the original in the editor.";
