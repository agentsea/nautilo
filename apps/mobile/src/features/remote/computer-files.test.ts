import { describe, expect, test } from "bun:test";
import { pairedFilesystemDisplayPath } from "./computer-files-presentation";
const source = await Bun.file(new URL("./computer-files.ts", import.meta.url)).text();
const browserSource = await Bun.file(
  new URL("../../app/files/computer/[remoteHostId]/[rootKind].tsx", import.meta.url),
).text();
const filesSource = await Bun.file(
  new URL("../../app/(drawer)/(tabs)/files.tsx", import.meta.url),
).text();

describe("Computer Files mobile presentation", () => {
  test("keeps workspace and optional Current Folder distinct", () => {
    expect(source).toContain('rootKind === "paired_filesystem"');
    expect(source).toContain('return "Current Folder"');
    expect(browserSource).toContain('rootKind ? rootTitle(rootKind) : "Computer files"');
  });

  test("projects opaque paired-filesystem tokens as a location label and human subpath", () => {
    expect(pairedFilesystemDisplayPath("", undefined)).toBe("This Mac");
    expect(pairedFilesystemDisplayPath("loc_data", "Macintosh HD — Data")).toBe("Macintosh HD — Data");
    expect(pairedFilesystemDisplayPath("loc_data/Data/project", "Macintosh HD — Data")).toBe("Macintosh HD — Data / Data / project");
    expect(pairedFilesystemDisplayPath("loc_secret/Documents", "loc_secret")).toBe("This Mac / Documents");
    expect(browserSource).toContain("locationLabel");
    expect(browserSource).toContain("pairedFilesystemDisplayPath(relativePath, locationLabel)");
  });

  test("presents paired computers as a Files source instead of redirecting to management", () => {
    expect(filesSource).toContain('useState<"nautilo" | "computer">("nautilo")');
    expect(filesSource).toContain('onPress={() => setSource("computer")}');
    expect(filesSource).toContain("<ComputerSource");
    expect(filesSource).toContain('title="Workspace"');
    expect(filesSource).toContain('title="Current Folder"');
    expect(filesSource).toContain('title="Change Current Folder"');
    expect(filesSource).toContain('rootKind: "paired_filesystem", mode: "choose"');
    expect(filesSource).toContain("Pair or manage computers");
    expect(filesSource).toContain("activeHostId={remoteHosts.activeHostId}");
    expect(filesSource).toContain("data={activeHost ? [activeHost] : []}");
    expect(filesSource).toContain("Change active computer");
  });

  test("does not turn a missing Current Folder into a workspace fallback", () => {
    expect(source).toContain('case "no_current_folder"');
    expect(source).toContain('title: "No Current Folder selected"');
    expect(source).toContain("Choose a folder on this computer from your phone.");
    expect(source).not.toContain('no_current_folder" ? "workspace"');
    expect(browserSource).toContain('>Choose a folder</Text>');
    expect(browserSource).toContain('rootKind: "paired_filesystem", mode: "choose"');
    expect(browserSource).not.toContain("Choose a Current Folder in Nautilo Desktop");
  });

  test("keeps revoked access and an offline computer semantically separate", () => {
    expect(source).toContain('case "revoked"');
    expect(source).toContain('title: "Access was revoked"');
    expect(source).toContain('case "offline"');
    expect(source).toContain('title: "Computer is offline"');
  });

  test("does not blame the computer for a Nautilo service failure", () => {
    expect(source).toContain('case "service"');
    expect(source).toContain('title: "Nautilo is temporarily unavailable"');
    expect(source).toContain('if (error.status >= 500) return "service"');
    expect(source).toContain('case "transport"');
    expect(source).toContain('title: "Could not reach this computer"');
  });

  test("keeps the browser relative-only and bounded", () => {
    expect(browserSource).toContain("validRelativePath");
    expect(browserSource).toContain("!value.startsWith(\"/\")");
    expect(browserSource).toContain("limit: PAGE_SIZE");
    expect(browserSource).toContain("readComputerFilePreview");
    expect(browserSource).toContain("base64ToBytes(dataBase64)");
    expect(browserSource).not.toContain("globalThis.atob");
    expect(browserSource).toContain("const actionable = !entry.isSymbolicLink");
    expect(browserSource).toContain("style={styles.browserBody}");
    expect(browserSource).toContain("alwaysBounceVertical");
    expect(browserSource).toContain("ListHeaderComponent={<View style={styles.listHeader}>");
    expect(browserSource).not.toContain("nestedScrollEnabled");
    expect(browserSource).toContain('accessibilityLabel="Updating folder contents"');
  });

  test("keeps hidden-file choice and folder search inside the signed bounded request", () => {
    expect(browserSource).toContain("includeHidden: showHidden");
    expect(browserSource).toContain("query: debouncedQuery");
    expect(browserSource).toContain('placeholder="Search this folder"');
    expect(browserSource).toContain('accessibilityLabel="Show hidden files"');
  });

  test("makes folder selection explicit and exact-host scoped", () => {
    expect(source).toContain('select: "/api/remote/current-folder/select"');
    expect(browserSource).toContain('firstParam(params.mode) === "choose"');
    expect(browserSource).toContain("selectComputerCurrentFolder(target");
    expect(browserSource).toContain("sourceRootKind: rootKind");
    expect(browserSource).toContain("Change Current Folder on ${hostLabel}?");
    expect(browserSource).toContain("Use this folder");
    expect(browserSource).toContain("Opening folders does not change anything.");
    expect(browserSource).toContain('rootKind === "paired_filesystem" && relativePath === ""');
  });
});
