import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mobileSource = resolve(import.meta.dir, "..");

describe("iOS local-network recovery UI contract", () => {
  test("keeps the Settings action behind the iOS local-failure decision", () => {
    const component = readFileSync(
      resolve(mobileSource, "components/ios-local-network-recovery.tsx"),
      "utf8",
    );

    expect(component).toContain("shouldOfferIosLocalNetworkRecovery");
    expect(component).toContain("platform: Platform.OS");
    expect(component).toContain("await Linking.openSettings()");
    expect(component).toContain("Couldn’t open Settings");
    expect(component).toContain("accessibilityLiveRegion=\"polite\"");
  });

  test("makes recovery reachable from connection and saved-server sign-in failures", () => {
    const addServer = readFileSync(
      resolve(mobileSource, "app/(onboarding)/add-server.tsx"),
      "utf8",
    );
    const signIn = readFileSync(
      resolve(mobileSource, "app/(onboarding)/sign-in.tsx"),
      "utf8",
    );
    const browserAddServer = readFileSync(
      resolve(mobileSource, "app/(onboarding)/add-server.web.tsx"),
      "utf8",
    );

    expect(addServer).toContain("<IosLocalNetworkRecovery error={error} serverUrl={url} />");
    expect(signIn).toContain("<IosLocalNetworkRecovery");
    expect(signIn).toContain('serverUrl={activeServer?.serverUrl ?? ""}');
    expect(browserAddServer).not.toContain("IosLocalNetworkRecovery");
  });
});
