/**
 * Security contract for a managed Semgrep CE invocation.  Rule content must
 * be installed under the separately pinned `rules` identity; network configs
 * (`auto`, registry names, URLs) and telemetry/version checks are not options.
 */
export function semgrepOfflineScanArguments(input: {
  readonly localRulesPath: string;
  readonly targetPath: string;
}): readonly string[] {
  const localAbsolute = (value: string): boolean => value.startsWith("/") && !value.split("/").some((part) => part === ".." || part === ".");
  if (!localAbsolute(input.localRulesPath) || !localAbsolute(input.targetPath))
    throw new Error("semgrep_requires_local_absolute_paths");
  return Object.freeze([
    "scan",
    "--config", input.localRulesPath,
    "--metrics=off",
    "--disable-version-check",
    "--json",
    input.targetPath,
  ]);
}
