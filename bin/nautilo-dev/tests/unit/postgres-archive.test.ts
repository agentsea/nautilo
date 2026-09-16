import { describe, expect, test } from "bun:test";
import {
  dockerBindSourceOnHost,
  isNonPortableEventTriggerOwnerStatement,
  missingDockerBindSources,
  POSTGRES_DUMP_SHELL,
  POSTGRES_RESTORE_SHELL,
} from "../../src/lib/postgres-archive";

describe("Postgres archive Docker bind preflight", () => {
  test("preserves normal ownership while identifying the superuser-only event-trigger owner statement", () => {
    expect(POSTGRES_DUMP_SHELL).toContain("pg_dump -U");
    expect(POSTGRES_DUMP_SHELL).not.toContain("--no-owner");
    expect(isNonPortableEventTriggerOwnerStatement(
      "ALTER EVENT TRIGGER nautilo_guard OWNER TO nautilo;",
    )).toBe(true);
    expect(isNonPortableEventTriggerOwnerStatement(
      "ALTER TABLE public.systems OWNER TO logto;",
    )).toBe(false);
    expect(POSTGRES_RESTORE_SHELL).toContain("set -o pipefail");
    expect(POSTGRES_RESTORE_SHELL).toContain('gzip -dc -- "$1"');
    expect(POSTGRES_RESTORE_SHELL).toContain(
      "sed '/^ALTER EVENT TRIGGER .* OWNER TO .*;$/d'",
    );
    expect(POSTGRES_RESTORE_SHELL).toContain(
      'docker exec -i "$2" psql -U "$3" -v ON_ERROR_STOP=1 "$4"',
    );
  });

  test("normalizes Docker Desktop host mounts", () => {
    expect(dockerBindSourceOnHost("/host_mnt/Users/test/repo/file.sql"))
      .toBe("/Users/test/repo/file.sql");
    expect(dockerBindSourceOnHost("/srv/nautilo/file.sql"))
      .toBe("/srv/nautilo/file.sql");
  });

  test("reports only missing bind sources with their container destination", () => {
    expect(missingDockerBindSources([
      { Type: "volume", Source: "/var/lib/docker/volumes/x", Destination: "/data" },
      { Type: "bind", Source: "/host_mnt/Users/test/present", Destination: "/present" },
      { Type: "bind", Source: "/host_mnt/Users/test/deleted", Destination: "/docker-entrypoint-initdb.d/01-nautilo.sh" },
    ], (path) => path.endsWith("/present"))).toEqual([{
      source: "/Users/test/deleted",
      destination: "/docker-entrypoint-initdb.d/01-nautilo.sh",
    }]);
  });
});
