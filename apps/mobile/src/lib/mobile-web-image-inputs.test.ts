import { expect, test } from "bun:test";
import packageManifest from "../../package.json";

test("copies declared workspace sources into the Mobile Web image stage", async () => {
  const dockerfile = await Bun.file(new URL("../../../../packaging/docker/Dockerfile", import.meta.url)).text();
  const stage = dockerfile.split("FROM deps AS mobile-web-build\n")[1]?.split("\nFROM ")[0] ?? "";
  expect(stage).not.toBe("");
  for (const [name, version] of Object.entries(packageManifest.dependencies)) {
    if (!version.startsWith("workspace:")) continue;
    const directory = `packages/${name.replace("@nautilo/", "")}`;
    expect(stage).toContain(`COPY ${directory} ${directory}`);
  }
});
