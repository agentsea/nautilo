import { expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { composeProjectName, type ComposeDriverProfile } from "@nautilo/compose-driver";

import { createProductionComposeLifecycle } from "../../src/index.ts";

const enabled = process.env["NAUTILO_RUN_COMPOSE_LIFECYCLE_INTEGRATION"] === "1";
const integrationTest = enabled ? test : test.skip;

async function dockerLines(args: string[]): Promise<string[]> {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(`Docker ownership inspection failed: ${stderr.trim()}`);
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function exactProjectResources(project: string): Promise<string[]> {
  const label = `label=com.docker.compose.project=${project}`;
  const [containers, networks, volumes] = await Promise.all([
    dockerLines(["ps", "-a", "--filter", label, "--format", "container:{{.ID}}"]),
    dockerLines(["network", "ls", "--filter", label, "--format", "network:{{.ID}}"]),
    dockerLines(["volume", "ls", "--filter", label, "--format", "volume:{{.Name}}"]),
  ]);
  return [...containers, ...networks, ...volumes];
}

integrationTest("direct package lifecycle qualifies one disposable named Compose instance", async () => {
  const templateDir = process.env["NAUTILO_COMPOSE_TEMPLATE_DIR"]?.trim();
  const imageRef = process.env["NAUTILO_COMPOSE_INTEGRATION_IMAGE"]?.trim();
  if (!templateDir || !imageRef) {
    throw new Error(
      "Set NAUTILO_COMPOSE_TEMPLATE_DIR and NAUTILO_COMPOSE_INTEGRATION_IMAGE to run this explicit lane",
    );
  }
  const instanceId = `m269-${randomBytes(4).toString("hex")}`;
  if (!/^m269-[a-f0-9]{8}$/.test(instanceId)) throw new Error("Unsafe integration instance id");
  const operatorHome = await mkdtemp(join(tmpdir(), `${instanceId}-`));
  const journalPath = join(operatorHome, "m269-lifecycle-journal.json");
  const backupPath = join(operatorHome, "backup");
  const profile: ComposeDriverProfile = {
    name: instanceId,
    lifecycle: "compose",
    transport: "local",
    instance_id: instanceId,
    from_source: false,
    image_ref: imageRef,
    https: "off",
  };
  const project = composeProjectName(profile);
  if (project === "nautilo" || (await exactProjectResources(project)).length !== 0) {
    throw new Error(`Disposable Compose project is not absent before qualification: ${project}`);
  }
  await writeFile(journalPath, JSON.stringify({
    schemaVersion: 1,
    instanceId,
    profileName: profile.name,
    project,
    operatorHome,
    backupPath,
    stage: "prepared",
  }, null, 2), { mode: 0o600 });
  await chmod(journalPath, 0o600);

  const lifecycle = createProductionComposeLifecycle({
    profile,
    templateDir,
    operatorHome,
    ports: { clearOwnerClaimCustody: async () => undefined },
  });
  try {
    await lifecycle.deploy();
    expect((await lifecycle.inspect()).observation.health).toBe("ready");
    expect((await lifecycle.backup({ toPath: backupPath })).backupPath).toBe(backupPath);
    await lifecycle.upgrade({ artifact: "image", imageRef, scope: "full" });
    await lifecycle.restore({ fromPath: backupPath, force: true, mode: "full" });
    expect((await lifecycle.inspect()).observation.health).toBe("ready");
    await lifecycle.destroyHard();
    expect(await exactProjectResources(project)).toEqual([]);
    await writeFile(journalPath, JSON.stringify({
      schemaVersion: 1,
      instanceId,
      profileName: profile.name,
      project,
      operatorHome,
      backupPath,
      stage: "destroyed",
    }, null, 2), { mode: 0o600 });
  } catch (error) {
    try {
      await lifecycle.inspect();
      const owned = await exactProjectResources(project);
      if (owned.length > 0) await lifecycle.destroyHard();
    } catch {
      process.stderr.write(
        `M269 lifecycle target preserved because ownership/readiness could not be reconciled. `
        + `Journal: ${journalPath}. Recovery: bun test packages/compose-lifecycle/tests/integration/local-compose-lifecycle.integration.test.ts\n`,
      );
    }
    throw error;
  }
});
