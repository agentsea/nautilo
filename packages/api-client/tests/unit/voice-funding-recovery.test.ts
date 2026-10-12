import { expect, test } from "bun:test";
import { NautiloApiClient, VoiceFundingApiError } from "../../src/client";
import { parseVoiceFundingRecovery } from "@nautilo/types";

const recovery = {
  errorCode: "personal_credentials_disabled",
  repairAction: "contact_operator",
  href: "/settings#personal-provider-keys",
} as const;

test("voice recovery accepts only closed code/action/destination pairs", () => {
  expect(parseVoiceFundingRecovery({ ...recovery, error: "private-key", providerBody: "private-url" })).toEqual(recovery);
  expect(parseVoiceFundingRecovery({ ...recovery, href: "https://attacker.test" })).toBeNull();
  expect(parseVoiceFundingRecovery({ ...recovery, href: "/admin#provider-credentials" })).toBeNull();
  expect(parseVoiceFundingRecovery({ ...recovery, repairAction: "configure_server_provider_credentials" })).toBeNull();
});

for (const operation of ["hydrate", "catalog", "preview"] as const) {
  test(`${operation} preserves funding recovery without provider text`, async () => {
    const client = new NautiloApiClient("https://nautilo.test", {
      fetchImpl: async () => Response.json({ ...recovery, error: "private-key private-provider-url" }, { status: 403 }),
    });
    let failure: unknown;
    try {
      if (operation === "hydrate") await client.getVoiceCustomizationHydration();
      else if (operation === "catalog") await client.listVoiceCatalog();
      else await client.previewVoice("voice1");
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(VoiceFundingApiError);
    expect((failure as VoiceFundingApiError).recovery).toEqual(recovery);
    expect((failure as Error).message).toBe("Personal voice funding is disabled.");
  });
}

test("preview rejects a fabricated recovery link and retains rate-limit timing", async () => {
  const client = new NautiloApiClient("https://nautilo.test", {
    fetchImpl: async () => Response.json({ ...recovery, href: "https://attacker.test", error: "private-key" }, {
      status: 429, headers: { "retry-after": "2" },
    }),
  });
  let failure: unknown;
  try { await client.previewVoice("voice1"); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ message: "Voice preview unavailable.", retryAfterMs: 2000 });
});
