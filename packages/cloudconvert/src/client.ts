/**
 * CloudConvert SDK client wrapper.
 *
 * API keys should be scoped to `task.read` + `task.write` only — this adapter
 * uses jobs/tasks endpoints and does not call user/account APIs.
 *
 * @see https://github.com/cloudconvert/cloudconvert-node
 */

/**
 * CloudConvert SDK client interface (the SDK does not export proper types).
 */
export interface CloudConvertClient {
  jobs: {
    create: (config: {
      tag?: string;
      tasks: Record<string, unknown>;
    }) => Promise<CloudConvertJob>;
    wait: (jobId: string) => Promise<CloudConvertJob>;
    getExportUrls: (
      job: CloudConvertJob,
    ) => Array<{ url?: string; filename?: string }>;
  };
  tasks: {
    upload: (
      task: { id: string },
      stream: NodeJS.ReadableStream | Buffer,
      filename: string,
    ) => Promise<void>;
  };
}

export interface CloudConvertJob {
  id: string;
  tag?: string;
  status: string;
  tasks: CloudConvertTask[];
}

export interface CloudConvertTask {
  id: string;
  name: string;
  operation: string;
  status: string;
  message?: string;
  result?: {
    files?: Array<{ url?: string }>;
  };
}

type CloudConvertSDKConstructor = new (
  apiKey: string,
  sandbox: boolean,
  region?: string,
) => CloudConvertClient;

let cloudConvertSdk: CloudConvertSDKConstructor | null = null;

function loadCloudConvertSdk(): CloudConvertSDKConstructor {
  if (!cloudConvertSdk) {
    // Lazy require so type-checking and unit tests work without the SDK installed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require("cloudconvert") as {
      default?: CloudConvertSDKConstructor;
    } & CloudConvertSDKConstructor;
    cloudConvertSdk = module.default ?? module;
  }
  return cloudConvertSdk;
}

/**
 * Create a CloudConvert client for the given credentials.
 */
export function createCloudConvertClient(
  apiKey: string,
  sandbox: boolean,
  region?: string,
): CloudConvertClient {
  const SDK = loadCloudConvertSdk();
  return new SDK(apiKey, sandbox, region);
}
