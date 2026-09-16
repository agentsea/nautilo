import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  runCloudflareR2OAuthProbe,
  type CloudflareR2SessionRequest,
  type CloudflareR2SessionPort,
} from "../src/lib/cloudflare-r2-oauth-probe.ts";

const LIVE_CONFIRMATION = "create-test-delete-r2-oauth";
const clientId = process.env["NAUTILO_CLOUDFLARE_OAUTH_CLIENT_ID"]?.trim();
const accountId = process.env["NAUTILO_CLOUDFLARE_ACCOUNT_ID"]?.trim();
const r2WriteScope = process.env["NAUTILO_CLOUDFLARE_R2_WRITE_SCOPE"]?.trim();

if (
  process.env["NAUTILO_CLOUDFLARE_R2_OAUTH_LIVE"] !== LIVE_CONFIRMATION ||
  clientId === undefined || accountId === undefined || r2WriteScope === undefined
) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    outcome: "unconfirmed",
    next: "supply-private-oauth-client-and-explicit-live-confirmation",
  })}\n`);
  process.exitCode = 1;
} else {
  const createSession = (
    request: CloudflareR2SessionRequest,
  ): CloudflareR2SessionPort => {
    const client = new S3Client({
      endpoint: request.endpoint,
      region: "auto",
      credentials: request.credentials,
      forcePathStyle: true,
    });
    return {
      put: async ({ key, body }) => {
        await client.send(new PutObjectCommand({ Bucket: request.bucket, Key: key, Body: body }));
      },
      head: async ({ key }) => {
        const response = await client.send(new HeadObjectCommand({ Bucket: request.bucket, Key: key }));
        if (typeof response.ContentLength !== "number") throw new Error("invalid-head");
        return response.ContentLength;
      },
      get: async ({ key }) => {
        const response = await client.send(new GetObjectCommand({ Bucket: request.bucket, Key: key }));
        if (response.Body === undefined) throw new Error("invalid-get");
        return await response.Body.transformToByteArray();
      },
      delete: async ({ key }) => {
        await client.send(new DeleteObjectCommand({ Bucket: request.bucket, Key: key }));
      },
    };
  };

  const result = await runCloudflareR2OAuthProbe({
    clientId,
    accountId,
    r2WriteScope,
    createSession,
    openBrowser: async (url) => {
      const child = Bun.spawn(["open", "-a", "Firefox", url], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      if (await child.exited !== 0) throw new Error("browser-open-failed");
    },
  });
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...result })}\n`);
  if (result.outcome !== "passed") process.exitCode = 2;
}
