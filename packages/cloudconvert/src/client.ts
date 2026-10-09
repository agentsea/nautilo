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
    }, options?: { signal?: AbortSignal }) => Promise<CloudConvertJob>;
    wait: (jobId: string) => Promise<CloudConvertJob>;
    get: (jobId: string) => Promise<CloudConvertJob>;
    all: (query?: {
      "filter[tag]"?: string;
      per_page?: number;
      page?: number;
    }) => Promise<CloudConvertJob[]>;
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
    cancel: (taskId: string) => Promise<CloudConvertTask>;
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
  credits?: number | null;
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
  const client = new SDK(apiKey, sandbox, region);
  const baseUrl = sandbox
    ? "https://api.sandbox.cloudconvert.com/v2/"
    : `https://${region ? `${region}.` : ""}api.cloudconvert.com/v2/`;
  const sdkCreate = client.jobs.create.bind(client.jobs);
  client.jobs.create = async (config, options) => {
    if (!options?.signal) return sdkCreate(config);
    const response = await fetch(new URL("jobs", baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "nautilo-cloudconvert-request-client",
      },
      body: JSON.stringify(config),
      signal: options.signal,
    });
    if (!response.ok) throw new Error(response.statusText, { cause: response });
    const payload = await response.json() as { data?: CloudConvertJob };
    if (!payload.data) throw new Error("CloudConvert create response did not include a job");
    return payload.data;
  };
  return client;
}
