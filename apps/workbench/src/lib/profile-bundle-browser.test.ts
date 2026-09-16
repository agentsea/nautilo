import { describe, expect, test } from "bun:test";
import argon2 from "argon2";
import { argon2id } from "hash-wasm";
import {
  decryptProfileBundleFile,
  encryptProfileBundleFile,
  parseProfileBundleFile,
  serializeProfileBundleFile,
  type Argon2idDeriveFn,
  type semantic,
} from "@nautilo/profile-portability";
import {
  decryptProfileBundleFile as decryptCliProfileBundleFile,
  encryptProfileBundleFile as encryptCliProfileBundleFile,
  serializeProfileBundleFile as serializeCliProfileBundleFile,
} from "../../../cli/src/lib/profile-bundle.ts";
import { assertBrowserSupportedProfileBundle, disposeDecryptedProfileBundle } from "./profile-bundle-browser";
import { isProfileBundleCryptoWorkerRequest } from "../workers/profile-bundle-crypto-worker-protocol";

const passphrase = new TextEncoder().encode("correct horse battery staple");
const wrongPassphrase = new TextEncoder().encode("not the right password");
const salt = new Uint8Array(16).map((_, index) => index + 1);
const dek = new Uint8Array(32).map((_, index) => index + 10);

const records: readonly semantic.SemanticRecord[] = [
  { recordKind: "identity", name: "Aria", handleIntent: "aria" },
  { recordKind: "soul", text: "A calm, precise assistant." },
  { recordKind: "personality", text: "Warm but concise." },
  { recordKind: "voices", voices: [] },
  { recordKind: "modelPolicy", policy: { primaryModel: "gpt-5", fallbackModel: null, temperature: null } },
  { recordKind: "avatar", avatar: null },
  { recordKind: "preferences", preferences: {} },
  { recordKind: "memory", scope: "private", type: "general", content: "Prefers succinct answers.", createdAt: null },
];

const browserArgon2id: Argon2idDeriveFn = async ({ passphrase: password, salt: argonSalt, params }) => new Uint8Array(await argon2id({
  password,
  salt: argonSalt,
  iterations: params.timeCost,
  parallelism: params.parallelism,
  memorySize: params.memoryCostKiB,
  hashLength: params.outputLength,
  outputType: "binary",
}));

const cliArgon2id: Argon2idDeriveFn = async ({ passphrase: password, salt: argonSalt, params }) => new Uint8Array(await argon2.hash(Buffer.from(password), {
  type: argon2.argon2id,
  salt: Buffer.from(argonSalt),
  memoryCost: params.memoryCostKiB,
  timeCost: params.timeCost,
  parallelism: params.parallelism,
  hashLength: params.outputLength,
  raw: true,
}));

function encryptionInput(kdf: Argon2idDeriveFn) {
  return { records, bundleId: "browser-cli-compat-001", avatarBytes: null, avatarMedia: null, passphrase: passphrase.slice(), argon2id: kdf, salt: salt.slice(), dek: dek.slice() };
}

describe("profile bundle browser compatibility", () => {
  test("browser Argon2id creates an envelope the CLI can read, and the CLI creates one the browser core can read", async () => {
    const browserFile = await encryptProfileBundleFile(encryptionInput(browserArgon2id));
    const cliRead = await decryptCliProfileBundleFile(parseProfileBundleFile(serializeProfileBundleFile(browserFile)), passphrase.slice(), cliArgon2id);
    expect(cliRead.bundle.scopes).toEqual(["profile", "privateMemories"]);
    disposeDecryptedProfileBundle(cliRead);

    const cliFile = await encryptCliProfileBundleFile(encryptionInput(cliArgon2id));
    const browserRead = await decryptProfileBundleFile(parseProfileBundleFile(serializeCliProfileBundleFile(cliFile)), passphrase.slice(), browserArgon2id);
    expect(browserRead.records).toEqual(records);
    disposeDecryptedProfileBundle(browserRead);
  }, 60_000);

  test("wrong password, tampering, and unsupported sidecars are rejected before any import call", async () => {
    const file = await encryptProfileBundleFile(encryptionInput(browserArgon2id));
    await expect(decryptProfileBundleFile(file, wrongPassphrase.slice(), browserArgon2id)).rejects.toThrow("wrong passphrase");
    const tampered = structuredClone(file);
    const ciphertext = tampered.frames[0]?.ciphertext;
    if (ciphertext === undefined) throw new Error("fixture missing encrypted record");
    (tampered.frames as Array<{ ciphertext: string }>)[0]!.ciphertext = `${ciphertext[0] === "0" ? "1" : "0"}${ciphertext.slice(1)}`;
    await expect(decryptProfileBundleFile(tampered, passphrase.slice(), browserArgon2id)).rejects.toThrow();
    expect(() => assertBrowserSupportedProfileBundle({ ...file, artifactStream: { mediaVersion: 2, size: 1, sha256: "0".repeat(64) } })).toThrow("contains artifacts");
  }, 60_000);

  test("worker protocol admits only transferable, complete Argon2id requests", () => {
    expect(isProfileBundleCryptoWorkerRequest({ type: "derive-argon2id", requestId: "one", passphrase: new ArrayBuffer(1), salt: new ArrayBuffer(16), params: { memoryCostKiB: 19456, timeCost: 2, parallelism: 1, outputLength: 32 } })).toBe(true);
    expect(isProfileBundleCryptoWorkerRequest({ type: "derive-argon2id", requestId: "one", passphrase: new Uint8Array(1), salt: new ArrayBuffer(16), params: {} })).toBe(false);
  });
});
