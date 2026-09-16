import { installStableCliRelease } from "./lib/cli-release.ts";
import { VERSION } from "./version.ts";

type InstallerCommandInput = {
  argv?: string[];
  install?: typeof installStableCliRelease;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
};

export async function runInstallerCommand(input: InstallerCommandInput = {}): Promise<number> {
  const argv = input.argv ?? process.argv.slice(2);
  const stdout = input.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = input.stderr ?? ((value: string) => process.stderr.write(value));

  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    stdout(`${VERSION}\n`);
    return 0;
  }
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    stdout("Install the current verified Nautilo CLI release.\n\nUsage: install-nautilo [--help | --version]\n");
    return 0;
  }
  if (argv.length > 0) {
    stderr("Unknown installer argument. Run with --help.\n");
    return 2;
  }

  try {
    const result = await (input.install ?? installStableCliRelease)();
    stdout(`Installed Nautilo CLI ${result.version}. Ensure ~/.local/bin is on PATH, then run: nautilo --help\n`);
    return 0;
  } catch (error: unknown) {
    stderr(`${error instanceof Error ? error.message : "Nautilo CLI installation failed."}\n`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await runInstallerCommand();
}
