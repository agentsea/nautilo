import { NautiloError } from "./base";

export class ConfigurationError extends NautiloError {
  constructor(message: string, cause?: unknown) { super("CONFIG_INVALID", message, cause); this.name = "ConfigurationError"; }
}

export class InfraUnavailableError extends NautiloError {
  constructor(message: string, cause?: unknown) { super("INFRA_UNAVAILABLE", message, cause); this.name = "InfraUnavailableError"; }
}

export class TransientError extends NautiloError {
  constructor(message: string, cause?: unknown) { super("TRANSIENT", message, cause); this.name = "TransientError"; }
}

export class AuthenticationError extends NautiloError {
  constructor(message: string, cause?: unknown) { super("AUTH_FAILED", message, cause); this.name = "AuthenticationError"; }
}

export class AuthorizationError extends NautiloError {
  constructor(message: string, cause?: unknown) { super("FORBIDDEN", message, cause); this.name = "AuthorizationError"; }
}

export class ValidationError extends NautiloError {
  constructor(message: string, cause?: unknown) { super("VALIDATION", message, cause); this.name = "ValidationError"; }
}

export class ConcurrencyError extends NautiloError {
  constructor(message: string, cause?: unknown) { super("CONCURRENCY", message, cause); this.name = "ConcurrencyError"; }
}

export class QuotaError extends NautiloError {
  constructor(message: string, cause?: unknown) { super("QUOTA_EXCEEDED", message, cause); this.name = "QuotaError"; }
}

export class ToolExecutionError extends NautiloError {
  readonly toolName: string;
  constructor(toolName: string, message: string, cause?: unknown) {
    super("TOOL_EXECUTION", message, cause);
    this.name = "ToolExecutionError";
    this.toolName = toolName;
  }
}

export class NotFoundError extends NautiloError {
  constructor(resource: string, id?: string, cause?: unknown) {
    super("NOT_FOUND", id ? `${resource} not found: ${id}` : `${resource} not found`, cause);
    this.name = "NotFoundError";
  }
}
