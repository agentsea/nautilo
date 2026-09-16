/**
 * @nautilo/cloudconvert — optional CloudConvert conversion backend (D306).
 *
 * API keys should be scoped to task.read + task.write only.
 */

export type {
  CloudConvertClient,
  CloudConvertJob,
  CloudConvertTask,
} from "./client.ts";
export { createCloudConvertClient } from "./client.ts";

export type { CloudConvertConfig } from "./config.ts";
export {
  getCloudConvertConfig,
  isCloudConvertConfigured,
  resolveConvertConfig,
} from "./config.ts";

export type { ConvertOptions } from "./service.ts";
export { convert } from "./service.ts";

export type { JobTagData } from "./tags.ts";
export {
  createJobTag,
  parseJobTag,
  verifyJobAccess,
  verifyJobOwnership,
} from "./tags.ts";

// (No HTML pre-cleaning: the convert path sends the Genie's already-clean HTML
// straight to CloudConvert. If a future path needs jsdom-based cleaning, add it
// behind a dedicated subpath export so this entry stays DOM-free / server-safe.)
