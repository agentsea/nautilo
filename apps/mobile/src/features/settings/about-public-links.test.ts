import { describe, expect, test } from "bun:test";

const source = await Bun.file(
  new URL("../../app/(drawer)/(tabs)/settings/about.tsx", import.meta.url),
).text();

describe("Mobile About public links", () => {
  test("opens the shared Privacy and email destinations through guarded native Linking", () => {
    expect(source).toContain('import { PUBLIC_PRODUCT_LINKS } from "@nautilo/types"');
    expect(source).toContain("PUBLIC_PRODUCT_LINKS.privacyPolicyUrl");
    expect(source).toContain("PUBLIC_PRODUCT_LINKS.supportContactUrl");
    expect(source.match(/Linking\.openURL/g)).toHaveLength(1);
    expect(source.match(/accessibilityRole="link"/g)).toHaveLength(2);
    expect(source).toContain("Privacy Policy");
    expect(source).toContain("support@kentauros.ai");
  });

  test("turns a missing browser or email handler into a useful alert", () => {
    expect(source).toContain("try {");
    expect(source).toContain("Alert.alert(unavailableTitle, unavailableMessage)");
    expect(source).toContain('"Browser unavailable"');
    expect(source).toContain('"Email app unavailable"');
    expect(source).toContain('"Contact Nautilo support at support@kentauros.ai."');
  });
});
