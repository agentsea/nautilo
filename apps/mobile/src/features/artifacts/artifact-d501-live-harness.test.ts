import { expect, test } from "bun:test";

const mobileRoot = new URL("../../../", import.meta.url);

async function sourceFlow(name: string): Promise<string> {
  return Bun.file(new URL(`.maestro/${name}`, mobileRoot)).text();
}

test("D501 Android and iOS harnesses target the source editor only", async () => {
  const app = (await Bun.file(new URL("app.json", mobileRoot)).json()) as {
    expo: {
      android: { package: string };
      ios: { bundleIdentifier: string };
    };
  };
  const flows = [
    await sourceFlow("d501-android-source-actions.yaml"),
    await sourceFlow("d501-ios-source-actions.yaml"),
  ];
  const sourceEditor = await Bun.file(
    new URL("src/features/artifacts/native-source-editor.tsx", mobileRoot),
  ).text();
  const routing = await Bun.file(
    new URL("src/features/artifacts/artifact-viewer-routing.tsx", mobileRoot),
  ).text();

  expect(flows[0]).toContain(`appId: ${app.expo.android.package}`);
  expect(flows[1]).toContain(`appId: ${app.expo.ios.bundleIdentifier}`);
  for (const flow of flows) {
    expect(flow).toContain("${D501_MARKDOWN_ID}");
    expect(flow).not.toMatch(/password|token|artifactId:/i);
    for (const label of [
      "Edit file",
      "File source editor",
      "Bold",
      "Italic",
      "Add link",
      "Link address",
      "Cancel link editing",
      "Preview",
      "Edit",
      "Save file",
    ]) {
      expect(flow).toContain(JSON.stringify(label));
    }
    expect(flow).not.toMatch(/writer document editor|underline/i);
  }
  expect(sourceEditor).toContain('accessibilityLabel="File source editor"');
  expect(routing).toContain('accessibilityLabel="Edit file"');
});

function expectAllRowsNotRun(rows: Record<string, unknown>): void {
  for (const value of Object.values(rows)) {
    if (value !== null && typeof value === "object") {
      expectAllRowsNotRun(value as Record<string, unknown>);
    } else {
      expect(value).toBe("not-run");
    }
  }
}

test("D501 platform evidence templates keep every live-only row open", async () => {
  const manifests = await Promise.all([
    Bun.file(
      new URL("evidence/d501/4.2-android/manifest.template.json", mobileRoot),
    ).json(),
    Bun.file(
      new URL("evidence/d501/4.3-ios/manifest.template.json", mobileRoot),
    ).json(),
    Bun.file(
      new URL("evidence/d501/4.4-desktop/manifest.template.json", mobileRoot),
    ).json(),
  ]) as Array<Record<string, unknown>>;
  for (const manifest of manifests) {
    expect(manifest.status).toBe("not-run");
    expect(JSON.stringify(manifest)).not.toMatch(/"pass"|"complete"/i);
    if (manifest.automatedRows) {
      expectAllRowsNotRun(manifest.automatedRows as Record<string, unknown>);
    }
    expectAllRowsNotRun(manifest.manualCheckpoints as Record<string, unknown>);
  }
  for (const manifest of manifests.slice(0, 2)) {
    expect(JSON.stringify(manifest)).toContain("writer");
    expect(JSON.stringify(manifest)).not.toMatch(
      /writerSelection|writerConflict|WriterToDesktop|desktopToIosWriter/i,
    );
  }
});

test("D501 mobile package and production route contain no rich Writer editor", async () => {
  const packageJson = await Bun.file(new URL("package.json", mobileRoot)).text();
  const route = await Bun.file(
    new URL("src/app/files/artifact/edit/[id].tsx", mobileRoot),
  ).text();
  const admission = await Bun.file(
    new URL("src/features/artifacts/artifact-edit-admission.ts", mobileRoot),
  ).text();
  for (const source of [packageJson, route, admission]) {
    expect(source).not.toMatch(
      /react-native-enriched-html|WriterArtifactEditor|IosWriterEditor|ios-writer|writer-candidate/,
    );
  }
});
