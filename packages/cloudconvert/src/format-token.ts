export const CLOUDCONVERT_FORMAT_TOKEN_MAX_LENGTH = 32;

/**
 * CloudConvert format identifiers are normalized before they cross the
 * durable-operation boundary. Keep this aligned with the persisted varchar.
 */
export function isCloudConvertFormatToken(value: string): boolean {
  return value.length <= CLOUDCONVERT_FORMAT_TOKEN_MAX_LENGTH
    && /^[a-z0-9][a-z0-9._+-]*$/.test(value);
}
