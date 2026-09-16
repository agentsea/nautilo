export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function invariant(condition, status, code, message) {
  if (!condition) throw new HttpError(status, code, message);
}
export function responseError(error) {
  if (error instanceof HttpError) return { status: error.status, body: { code: error.code, message: error.message } };
  return { status: 500, body: { code: "internal_error", message: "The request could not be completed" } };
}
export function requiredString(value, name) {
  invariant(typeof value === "string" && value.trim().length > 0, 400, "invalid_input", `${name} is required`);
  return value;
}
