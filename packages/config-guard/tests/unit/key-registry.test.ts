import { describe, expect, test } from "bun:test";
import { getKeyByEnvVar, KEY_REGISTRY } from "../../src/key-registry";

test("provider descriptions avoid recommendations and explain gateway prerequisites", () => {
  expect(getKeyByEnvVar("ANTHROPIC_API_KEY")?.purpose).toBe("Anthropic models");
  expect(getKeyByEnvVar("NAUTILO_GATEWAY_API_KEY")?.purpose).toContain("NAUTILO_GATEWAY_BASE_URL");
  expect(getKeyByEnvVar("NAUTILO_GATEWAY_API_KEY")?.purpose).toContain("model selection");
});

describe("key-registry", () => {
  test("uses provider key dashboards and omits a signup destination for custom gateways", () => {
    expect(getKeyByEnvVar("ANTHROPIC_API_KEY")?.signupUrl).toBe("https://platform.claude.com/settings/keys");
    expect(getKeyByEnvVar("FIREWORKS_API_KEY")?.signupUrl).toBe("https://app.fireworks.ai/settings/users/api-keys");
    expect(getKeyByEnvVar("ELEVENLABS_API_KEY")?.signupUrl).toBe("https://elevenlabs.io/app/developers/api-keys");
    expect(getKeyByEnvVar("NAUTILO_GATEWAY_API_KEY")?.signupUrl).toBe("");
  });

  test("registry has thirteen keys", () => {
    expect(KEY_REGISTRY.length).toBe(13);
  });

  test("getKeyByEnvVar resolves Venice", () => {
    const k = getKeyByEnvVar("VENICE_API_KEY");
    expect(k?.id).toBe("venice");
    expect(k?.formatCheck("vapi_opaque-format-1234567890")).toBe(true);
    // Too short → reject
    expect(k?.formatCheck("short")).toBe(false);
    expect(k?.formatCheck(" vapi_opaque-format-1234567890")).toBe(false);
    expect(k?.formatCheck("vapi_opaque-format-1234567890\n")).toBe(false);
    expect(k?.formatCheck("Bearer vapi_opaque-format-1234567890")).toBe(false);
  });

  test("Venice doctor hints detect foreign-provider keys", () => {
    const k = getKeyByEnvVar("VENICE_API_KEY");
    expect(k).toBeDefined();
    const hints = k!.doctorHints;
    const matched = (value: string) => hints.filter(h => h.condition(value)).map(h => h.message);
    expect(matched("sk-ant-api03-abcdefghijklmnopqrstuv")).toContain("This looks like an Anthropic key, not Venice");
    expect(matched("sk-proj-abcdefghijklmnopqrstuv")).toContain("This looks like an OpenAI key, not Venice");
    expect(matched("fw_abcdefghijklmnopqrstuv")).toContain("This looks like a Fireworks key, not Venice");
    expect(matched("AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toContain("This looks like a Google key, not Venice");
    expect(matched(" padded ")).toContain("Key has leading/trailing whitespace");
    expect(matched("Bearer vapi_opaque-format-1234567890")).toContain(
      "Paste the raw Venice key only — do not include a 'Bearer ' prefix",
    );
    expect(matched("vapi_opaque format-1234567890")).toContain(
      "Key must be one printable line without spaces or control characters",
    );
  });

  test("getKeyByEnvVar resolves OpenAI", () => {
    const k = getKeyByEnvVar("OPENAI_API_KEY");
    expect(k?.id).toBe("openai");
    expect(k?.required).toBe(false);
    expect(k?.formatCheck("sk-proj-123456789012345678901234")).toBe(true);
  });

  test("rejects wrong provider shape for Anthropic slot", () => {
    const k = getKeyByEnvVar("ANTHROPIC_API_KEY");
    expect(k?.formatCheck("sk-proj-abc")).toBe(false);
  });

  test("OpenRouter expects sk-or-v1 prefix and rejects direct provider keys", () => {
    const k = getKeyByEnvVar("OPENROUTER_API_KEY");
    expect(k?.id).toBe("openrouter");
    expect(k?.formatCheck("sk-or-v1-123456789012345678901234")).toBe(true);
    expect(k?.formatCheck("sk-proj-123456789012345678901234")).toBe(false);
    expect(k?.formatCheck("sk-ant-api03-123456789012345678901234")).toBe(false);
  });

  test("generic gateway key accepts opaque non-empty values", () => {
    const k = getKeyByEnvVar("NAUTILO_GATEWAY_API_KEY");
    expect(k?.id).toBe("gateway");
    expect(k?.formatCheck("local-gateway-key")).toBe(true);
    expect(k?.formatCheck("")).toBe(false);
  });

  test("ElevenLabs expects sk_ prefix and length", () => {
    const k = getKeyByEnvVar("ELEVENLABS_API_KEY");
    expect(k?.formatCheck("sk_12345678901234567890")).toBe(true);
    expect(k?.formatCheck("not_sk_prefix_12345678901234567890")).toBe(false);
  });

  test("Groq expects gsk_ prefix and length", () => {
    const k = getKeyByEnvVar("GROQ_API_KEY");
    expect(k?.id).toBe("groq");
    expect(k?.formatCheck("gsk_12345678901234567890")).toBe(true);
    expect(k?.formatCheck("sk_12345678901234567890")).toBe(false);
  });

  test("Google and Tavily format checks", () => {
    // Classic AI Studio prefix still accepted (opaque length check).
    expect(getKeyByEnvVar("GOOGLE_API_KEY")?.formatCheck("AIzaSy0123456789012345678901234567890123")).toBe(true);
    // Newer Google Cloud / Gemini console keys (e.g. AQ.…).
    expect(getKeyByEnvVar("GOOGLE_API_KEY")?.formatCheck("AQ.Ab8RN6KMRdJWBR7PpH7JDKKrkJVstiPHi2")).toBe(true);
    expect(getKeyByEnvVar("GOOGLE_API_KEY")?.formatCheck("short")).toBe(false);
    expect(getKeyByEnvVar("TAVILY_API_KEY")?.formatCheck("tvly-12345678901")).toBe(true);
    expect(getKeyByEnvVar("FIREWORKS_API_KEY")?.formatCheck("fw_12345678901")).toBe(true);
    expect(getKeyByEnvVar("OPENROUTER_API_KEY")?.formatCheck("sk-or-v1-1234567890abcdef")).toBe(true);
    expect(getKeyByEnvVar("OPENROUTER_API_KEY")?.formatCheck("sk-proj-1234567890abcdef")).toBe(false);
    expect(getKeyByEnvVar("OPENROUTER_API_KEY")?.formatCheck("short")).toBe(false);
  });

  test("Browser Use is a normal server-managed API key", () => {
    const key = getKeyByEnvVar("BROWSER_USE_API_KEY");
    expect(key?.id).toBe("browser-use");
    expect(key?.category).toBe("browser");
    expect(key?.healthCheck).toBe("format_only");
    expect(key?.formatCheck("bu_12345678901234567890")).toBe(true);
    expect(key?.formatCheck("BROWSER_USE_API=bu_12345678901234567890")).toBe(false);
    expect(key?.formatCheck(" bu_12345678901234567890")).toBe(false);
  });

  test("getKeyByEnvVar resolves CloudConvert as a long three-segment JWT", () => {
    const k = getKeyByEnvVar("CLOUDCONVERT_API_KEY");
    expect(k?.id).toBe("cloudconvert");
    expect(k?.category).toBe("conversion");
    const jwt = [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "a".repeat(100),
      "b".repeat(100),
    ].join(".");
    expect(k?.formatCheck(jwt)).toBe(true);
    expect(k?.formatCheck("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123")).toBe(false);
    expect(k?.formatCheck(`Bearer ${jwt}`)).toBe(false);
    expect(k?.formatCheck("short")).toBe(false);
  });
});

test("TypeSafe is a decision credential and cannot satisfy chat setup", () => {
  expect(getKeyByEnvVar("TYPESAFE_API_KEY")).toMatchObject({ id: "typesafe", category: "decision", signupUrl: "https://console.typesafe.ai/" });
});
