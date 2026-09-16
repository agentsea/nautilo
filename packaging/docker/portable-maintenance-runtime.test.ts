import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("portable maintenance runtime image contract", () => {
  test("includes the browser-safe Desktop contracts consumed by Workbench", async () => {
    const root = resolve(import.meta.dir, "../..");
    const dockerfile = await readFile(resolve(root, "packaging/docker/Dockerfile"), "utf8");
    const workbenchStage = dockerfile.slice(
      dockerfile.indexOf("FROM deps AS workbench-build"),
      dockerfile.indexOf("# ─── Stage 4: Mobile Web static export"),
    );

    for (const contract of [
      "server-target.ts",
      "connection-attempt.ts",
      "connection-presentation.ts",
      "connection-support-receipt.ts",
      "ready-to-work-contract.ts",
    ]) {
      expect(workbenchStage).toContain(
        `COPY apps/desktop/electron/${contract} apps/desktop/electron/${contract}`,
      );
    }
  });

  test("ships exact PG17 and PG16 clients, GNU tar, and maintenance entrypoint source", async () => {
    const root = resolve(import.meta.dir, "../..");
    const dockerfile = await readFile(resolve(root, "packaging/docker/Dockerfile"), "utf8");
    expect(dockerfile).toContain("postgresql-client-17");
    expect(dockerfile).toContain("install -m 0755 /usr/lib/postgresql/17/bin/pg_dump /usr/local/bin/pg_dump");
    expect(dockerfile).toContain("install -m 0755 /usr/lib/postgresql/17/bin/pg_restore /usr/local/bin/pg_restore");
    expect(dockerfile).toContain("install -m 0755 /usr/lib/postgresql/17/bin/psql /usr/local/bin/psql");
    expect(dockerfile).toContain("postgres@sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b AS pg16-client");
    expect(dockerfile).toContain("COPY --from=pg16-client /usr/lib/postgresql/16/bin/pg_dump /usr/local/bin/pg_dump16");
    expect(dockerfile).toContain("COPY --from=pg16-client /usr/lib/postgresql/16/bin/pg_restore /usr/local/bin/pg_restore16");
    expect(dockerfile).toContain("COPY --from=pg16-client /usr/lib/postgresql/16/bin/psql /usr/local/bin/psql16");
    expect(dockerfile).toContain("apt-get purge -y postgresql-client-17 postgresql-client-common perl libperl5.40 perl-modules-5.40");
    expect(dockerfile).toContain("unexpected maintenance build dependency retained");
    expect(dockerfile).toContain(" tar ");
    expect(dockerfile).toContain("psql --version");
    expect(dockerfile).toContain("psql16 --version | grep -F '16.'");
    expect(dockerfile).toContain("COPY bin/nautilo-server ./repo/bin/nautilo-server");
    const entrypoint = await readFile(resolve(root, "bin/nautilo-server/src/maintenance-job.ts"), "utf8");
    for (const direction of ["export", "restore", "migrate"]) expect(entrypoint).toContain(`\"${direction}\"`);
  });
});
