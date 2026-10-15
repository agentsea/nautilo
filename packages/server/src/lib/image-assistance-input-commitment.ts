import { createHmac } from "node:crypto";
import { PUSH_TOKEN_ENCRYPTION_KEY } from "@nautilo/operator-secrets";

const IMAGE_ASSISTANCE_INPUT_DOMAIN = "nautilo/image-assistance/input-commitment/v1";

/** Keep image/question fingerprints opaque in clear operational metadata. */
export function imageAssistanceInputCommitment(
  jobId: string,
  inputDigest: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const encoded = environment[PUSH_TOKEN_ENCRYPTION_KEY];
  if (!jobId.trim() || !/^[a-f0-9]{64}$/u.test(inputDigest)
    || encoded === undefined || !/^[a-f0-9]{64}$/iu.test(encoded)) {
    throw new TypeError("Image assistance input commitment is unavailable");
  }
  return `hmac-sha256:${createHmac("sha256", Buffer.from(encoded, "hex"))
    .update(JSON.stringify([IMAGE_ASSISTANCE_INPUT_DOMAIN, jobId, inputDigest]), "utf8")
    .digest("hex")}`;
}
