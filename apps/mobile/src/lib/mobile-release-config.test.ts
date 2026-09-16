import { describe, expect, test } from "bun:test";
import {
  PUBLIC_PRODUCT_LINKS,
  publicProductLinkErrors,
} from "@nautilo/types";

import appConfig from "../../app.json";
import easConfig from "../../eas.json";
import packageManifest from "../../package.json";
import releaseLedger from "../../releases/ledger.json";
import { MOBILE_RELEASE_CONTRACT } from "./release-contract";

const releaseVersion = appConfig.expo.version;
const releaseNote = await Bun.file(
  new URL(`../../releases/${releaseVersion}.md`, import.meta.url),
).text();

const PROHIBITED_RELEASE_CLAIMS = [
  /\bend[- ]to[- ]end encrypted\b/i,
  /\bE2E\b/,
  /\bzero[- ]knowledge\b/i,
  /\bciphertext[- ]only\b/i,
  /\bworks? without (?:a )?Nautilo server\b/i,
  /\ball (?:device |your )?data (?:is|are) encrypted\b/i,
] as const;

describe("mobile release configuration", () => {
  test("keeps one source-owned semantic version and release note", () => {
    expect(releaseVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageManifest.version).toBe(releaseVersion);
    expect(releaseVersion).toBe(MOBILE_RELEASE_CONTRACT.version);
    expect(appConfig.expo.ios).not.toHaveProperty("version");
    expect(appConfig.expo.android).not.toHaveProperty("version");
    expect(releaseNote).toContain(`version: ${releaseVersion}`);
    expect(releaseNote).toContain(`# Nautilo Mobile ${releaseVersion}`);
  });

  test("keeps the release ledger aligned with the source-owned version", () => {
    expect(releaseLedger.schemaVersion).toBe(1);
    expect(releaseLedger.currentRelease).toBe(releaseVersion);

    const versions = releaseLedger.releases.map((release) => release.version);
    expect(new Set(versions).size).toBe(versions.length);

    const current = releaseLedger.releases.find(
      (release) => release.version === releaseVersion,
    );
    expect(current).toBeDefined();
    expect(current?.releaseNotes).toBe(`${releaseVersion}.md`);

    for (const release of releaseLedger.releases) {
      expect(release.version).toMatch(/^\d+\.\d+\.\d+$/);
      if (release.candidateCommit !== null) {
        expect(release.candidateCommit).toMatch(/^[0-9a-f]{40}$/);
      }

      for (const build of release.builds) {
        // The builder may report an assembly commit distinct from candidateCommit.
        if ("gitCommitHash" in build) {
          expect(build.gitCommitHash).toMatch(/^[0-9a-f]{40}$/);
        }
        // New records preserve their own product source when the candidate advances.
        // Earlier ledger entries without this field remain historical evidence.
        if (release.version === releaseVersion || "sourceCommit" in build) {
          expect(build).toHaveProperty("sourceCommit");
          expect((build as { sourceCommit?: string }).sourceCommit).toMatch(
            /^[0-9a-f]{40}$/,
          );
        }
        expect(["ios", "android"]).toContain(build.platform);
        expect(Number.isInteger(build.nativeBuildNumber)).toBe(true);
        expect(build.nativeBuildNumber).toBeGreaterThan(0);
        expect(build.easBuildId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
      }
    }
  });

  test("locks the qualified server mode without protected-mode fallback", () => {
    expect(MOBILE_RELEASE_CONTRACT.supportedServerModes).toEqual([
      "plaintext_only",
    ]);
    expect(MOBILE_RELEASE_CONTRACT.unsupportedProtectedModeBehavior).toBe(
      "unavailable",
    );
    expect(releaseNote).toContain("server_mode: plaintext_only");
  });

  test("rejects prohibited security and standalone-product claims", () => {
    for (const claim of PROHIBITED_RELEASE_CLAIMS) {
      expect(releaseNote).not.toMatch(claim);
    }
  });

  test("keeps one production app identity across Expo and EAS", () => {
    expect(appConfig.expo.extra.eas.projectId).toBe(
      "d3f1dfdb-e084-4ebf-a478-91e0c6e07b81",
    );
    expect(appConfig.expo.ios.bundleIdentifier).toBe("ai.nautilo.app");
    expect(appConfig.expo.android.package).toBe("ai.nautilo.app");
    expect(appConfig.expo.android.googleServicesFile).toBe(
      "./google-services.json",
    );
    expect(easConfig.cli.appVersionSource).toBe("local");
    expect(easConfig.cli.requireCommit).toBe(true);
  });

  test("ships approved public Privacy, contact, and store support destinations", () => {
    expect(publicProductLinkErrors(PUBLIC_PRODUCT_LINKS)).toEqual([]);
    expect(PUBLIC_PRODUCT_LINKS).toEqual({
      privacyPolicyUrl: "https://nautilo.ai/privacy",
      supportContactUrl: "mailto:support@kentauros.ai",
      storeSupportUrl: "https://nautilo.ai/docs/use/mobile",
    });
  });

  test("does not declare background audio playback", () => {
    const audioPlugin = appConfig.expo.plugins.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === "expo-audio",
    );

    expect(audioPlugin).toEqual([
      "expo-audio",
      {
        microphonePermission: "Nautilo uses the microphone for voice input.",
        enableBackgroundPlayback: false,
      },
    ]);
  });

  test("retains only contributor simulator, device, and internal builds", () => {
    expect(Object.keys(easConfig.build).sort()).toEqual([
      "development-device", "development-simulator", "internal",
    ]);
    expect(easConfig.build["development-simulator"]).toEqual({
      developmentClient: true,
      distribution: "internal",
      ios: { simulator: true },
      credentialsSource: "local",
    });
    expect(easConfig.build["development-device"]).toEqual({
      developmentClient: true,
      distribution: "internal",
      credentialsSource: "local",
    });
    expect(easConfig.build.internal).toEqual({
      distribution: "internal",
      credentialsSource: "local",
    });
  });

  test("keeps official store submission and remote counter allocation outside product source", () => {
    expect(easConfig).not.toHaveProperty("submit");
    expect(easConfig.build).not.toHaveProperty("production");
    for (const profile of Object.values(easConfig.build)) {
      expect(profile.distribution).toBe("internal");
      expect(profile.credentialsSource).toBe("local");
      expect(profile).not.toHaveProperty("autoIncrement");
      expect(profile).not.toHaveProperty("extends");
    }
  });

  test("has a development client but no implicit OTA runtime", () => {
    expect(packageManifest.dependencies["expo-dev-client"]).toBe("~57.0.10");
    expect(packageManifest.dependencies).not.toHaveProperty("expo-updates");
    expect(easConfig.build["development-simulator"]).not.toHaveProperty(
      "channel",
    );
    expect(easConfig.build.internal).not.toHaveProperty("channel");
    expect(easConfig.build["development-device"]).not.toHaveProperty("channel");
  });
});
