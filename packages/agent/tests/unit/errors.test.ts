import { describe, expect, test } from "bun:test";
import {
  NautiloError,
  ConfigurationError,
  InfraUnavailableError,
  TransientError,
  AuthenticationError,
  AuthorizationError,
  ValidationError,
  ConcurrencyError,
  QuotaError,
  ToolExecutionError,
  NotFoundError,
} from "../../src/index";

describe("error class library", () => {
  test("NautiloError carries code, message, and cause", () => {
    const cause = new Error("original");
    const err = new NautiloError("TEST_CODE", "test message", cause);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NautiloError);
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("test message");
    expect(err.cause).toBe(cause);
    expect(err.name).toBe("NautiloError");
  });

  test("NautiloError serializes to JSON", () => {
    const err = new NautiloError("TEST", "msg");
    const json = err.toJSON();
    expect(json).toEqual({ name: "NautiloError", code: "TEST", message: "msg" });
  });

  const errorClasses = [
    { Class: ConfigurationError, name: "ConfigurationError", code: "CONFIG_INVALID", args: ["bad config"] },
    { Class: InfraUnavailableError, name: "InfraUnavailableError", code: "INFRA_UNAVAILABLE", args: ["db down"] },
    { Class: TransientError, name: "TransientError", code: "TRANSIENT", args: ["timeout"] },
    { Class: AuthenticationError, name: "AuthenticationError", code: "AUTH_FAILED", args: ["bad token"] },
    { Class: AuthorizationError, name: "AuthorizationError", code: "FORBIDDEN", args: ["forbidden"] },
    { Class: ValidationError, name: "ValidationError", code: "VALIDATION", args: ["bad input"] },
    { Class: ConcurrencyError, name: "ConcurrencyError", code: "CONCURRENCY", args: ["lane locked"] },
    { Class: QuotaError, name: "QuotaError", code: "QUOTA_EXCEEDED", args: ["limit reached"] },
  ] as const;

  for (const { Class, name, code, args } of errorClasses) {
    test(`${name} extends NautiloError with code ${code}`, () => {
      const err = new Class(args[0]);
      expect(err).toBeInstanceOf(NautiloError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
      expect(err.code).toBe(code);
      expect(err.message).toBe(args[0]);
    });
  }

  test("ToolExecutionError includes tool name", () => {
    const err = new ToolExecutionError("search_memory", "query failed");
    expect(err).toBeInstanceOf(NautiloError);
    expect(err.name).toBe("ToolExecutionError");
    expect(err.code).toBe("TOOL_EXECUTION");
    expect(err.message).toBe("query failed");
    expect(err.toolName).toBe("search_memory");
  });

  test("NotFoundError formats resource and id", () => {
    const err = new NotFoundError("Thread", "abc-123");
    expect(err).toBeInstanceOf(NautiloError);
    expect(err.name).toBe("NotFoundError");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Thread not found: abc-123");
  });

  test("NotFoundError works without id", () => {
    const err = new NotFoundError("Profile");
    expect(err.message).toBe("Profile not found");
  });

  test("cause is preserved through subclasses", () => {
    const original = new Error("root cause");
    const err = new InfraUnavailableError("checkpoint store down", original);
    expect(err.cause).toBe(original);
  });
});
