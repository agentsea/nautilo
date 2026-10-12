import { expect, test } from "bun:test";
import { BolterCliClient } from "../../electron/bolter-bridge/cli-client";
import { BOLTER_CLI_RELEASE, getBolterProductionDecoders } from "../../electron/bolter-bridge/production-contract";

// Synthetic values in the exact two-line provider prompt; no live login URL is retained.
const prompt = "Open this link on any device to sign in (or create a Bolter account): https://bolter.chat/device?code=ABCD-EFGH\n"
  + "Check that the page shows the code ABCD-EFGH. If this command is stopped, run it again to keep waiting on the same code.\n";
const client = new BolterCliClient({ runtime: { executable: "/opt/nautilo/bolter-agent", home: "/var/lib/nautilo/synthetic-home",
  platform: "darwin", version: BOLTER_CLI_RELEASE.version }, decoders: getBolterProductionDecoders(BOLTER_CLI_RELEASE.version),
  isCurrent: () => true, attest: () => Promise.resolve(true), execute: () => { throw new Error("Decoder must not execute the provider"); } });

test("production login decoder accepts only the complete observed prompt and consistent code", () => {
  expect(client.decodeAuthLink(prompt)).toEqual({ ok: true, value: {
    url: "https://bolter.chat/device?code=ABCD-EFGH", code: "ABCD-EFGH",
  } });
  for (let length = 0; length < prompt.length; length++) expect(client.decodeAuthLink(prompt.slice(0, length)).ok).toBe(false);
  expect(client.decodeAuthLink(prompt.replace("shows the code ABCD-EFGH", "shows the code IJKL-MNOP")).ok).toBe(false);
});

test("login decoder rejects duplicate, credential-bearing, retargeted and extra-data prompts", () => {
  const invalid = [
    prompt + prompt, prompt + "\n", prompt + "extra output\n", "extra output\n" + prompt,
    prompt.replace("https://bolter.chat", "http://bolter.chat"),
    prompt.replace("https://bolter.chat", "https://bolter.chat.example.com"),
    prompt.replace("https://bolter.chat", "https://user:fixture@example.com"),
    prompt.replace("/device?", "/other?"),
    prompt.replace("?code=ABCD-EFGH", "?code=ABCD-EFGH&code=ABCD-EFGH"),
    prompt.replace("?code=ABCD-EFGH", "?code=ABCD-EFGH&token=synthetic-value"),
    prompt.replace("?code=ABCD-EFGH", "?code=ABCD-EFGH#fragment"),
    prompt.replaceAll("ABCD-EFGH", "abcd-efgh"), prompt.replaceAll("\n", "\r\n"),
  ];
  for (const input of invalid) expect(client.decodeAuthLink(input)).toEqual({ ok: false, reason: "unsupported-output" });
});

test("observed login prompt does not qualify authentication, listening or publication", () => {
  const decoders = getBolterProductionDecoders(BOLTER_CLI_RELEASE.version);
  expect(decoders?.authLink).toBeFunction();
  expect([decoders?.identity, decoders?.conversations, decoders?.receiveItem, decoders?.receipt]).toEqual([
    undefined, undefined, undefined, undefined,
  ]);
  expect(getBolterProductionDecoders("different-version")).toBeUndefined();
});
