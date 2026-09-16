import { expect, test } from "bun:test";
import { assertRequiredCloudEnv } from "../../src/cloud-env-guard";

test("local mode: always ok regardless of missing vars", () => {
  expect(assertRequiredCloudEnv({ NAUTILO_HOSTING_MODE: "local" })).toEqual({ ok: true });
});

test("cloud mode + OpenRouter-only chat credentials + required env: ok", () => {
  const env = {
    NAUTILO_HOSTING_MODE: "cloud",
    NAUTILO_BOOTSTRAP_TOKEN: "tok",
    OPENROUTER_API_KEY: "sk-or-v1-test",
    DB_CONNECTION_STRING: "postgres://app:pw@db/nautilo",
  };
  expect(assertRequiredCloudEnv(env)).toEqual({ ok: true });
});

test("cloud mode + another runtime-supported chat credential + required env: ok", () => {
  const env = {
    NAUTILO_HOSTING_MODE: "cloud",
    NAUTILO_BOOTSTRAP_TOKEN: "tok",
    VENICE_API_KEY: "venice-test",
    DB_CONNECTION_STRING: "postgres://app:pw@db/nautilo",
  };
  expect(assertRequiredCloudEnv(env)).toEqual({ ok: true });
});

test("cloud mode + no model-provider credentials + required env: ok", () => {
  const env = {
    NAUTILO_HOSTING_MODE: "cloud",
    NAUTILO_BOOTSTRAP_TOKEN: "tok",
    DB_CONNECTION_STRING: "postgres://...",
  };
  expect(assertRequiredCloudEnv(env)).toEqual({ ok: true });
});

test("non-chat provider keys do not become a cloud boot requirement", () => {
  const env = {
    NAUTILO_HOSTING_MODE: "cloud",
    NAUTILO_BOOTSTRAP_TOKEN: "tok",
    ELEVENLABS_API_KEY: "voice-only",
    TAVILY_API_KEY: "search-only",
    DB_CONNECTION_STRING: "postgres://...",
  };
  expect(assertRequiredCloudEnv(env)).toEqual({ ok: true });
});

test("cloud mode + missing NAUTILO_BOOTSTRAP_TOKEN: not ok", () => {
  const env = {
    NAUTILO_HOSTING_MODE: "cloud",
    OPENAI_API_KEY: "sk-test",
    DB_CONNECTION_STRING: "postgres://...",
  };
  const result = assertRequiredCloudEnv(env);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.message).toContain("NAUTILO_BOOTSTRAP_TOKEN");
});

test("cloud mode + missing DB_CONNECTION_STRING: not ok", () => {
  const env = {
    NAUTILO_HOSTING_MODE: "cloud",
    NAUTILO_BOOTSTRAP_TOKEN: "tok",
    OPENAI_API_KEY: "sk-test",
  };
  const result = assertRequiredCloudEnv(env);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.message).toContain("DB_CONNECTION_STRING");
});
