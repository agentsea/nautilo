#!/usr/bin/env bun
import { resolveRailwayQualificationRelease } from "../src/lib/railway-release-source";

const result = await resolveRailwayQualificationRelease(process.env);
if (result.state !== "verified" || result.channel !== "qualification") {
  process.stderr.write("railway.qualification-release.invalid\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`railway.qualification-release.verified ${result.manifest.releaseId}\n`);
}
