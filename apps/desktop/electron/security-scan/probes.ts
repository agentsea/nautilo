import type { SecurityScanProgress } from "@nautilo/relay";
import { JSONParser } from "@streamparser/json";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  securityScanObservationSchema,
  type SecurityScanObservation,
  type SecurityScanProbe,
  type SecurityScanProbeLane,
} from "@nautilo/types";

const SEMGREP_RULES_RELATIVE_PATH = "rules/security.yml";

export interface SecurityProbeEngineResolution {
  readonly state: "ready" | "unavailable";
  readonly internalPath: string | null;
}

export interface SecurityProbeProcessRequest {
  readonly executablePath: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly stdoutPath?: string | undefined;
}

export interface SecurityProbeProcessResult {
  readonly exitCode: number | null;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
}

export interface SecurityProbeSuiteDeps {
  readonly scratchRoot: string;
  readonly cacheRoot: string;
  readonly resolveGitleaks: (signal?: AbortSignal) => Promise<SecurityProbeEngineResolution>;
  readonly resolveOsvScanner: (signal?: AbortSignal) => Promise<SecurityProbeEngineResolution>;
  readonly resolveTrivy: (signal?: AbortSignal) => Promise<SecurityProbeEngineResolution>;
  readonly resolveSemgrep: (signal?: AbortSignal) => Promise<SecurityProbeEngineResolution>;
  readonly resolveSemgrepRules: (signal?: AbortSignal) => Promise<SecurityProbeEngineResolution>;
  readonly runProcess?: (request: SecurityProbeProcessRequest) => Promise<SecurityProbeProcessResult>;
}

export interface SecurityProbeSuiteResult {
  readonly lanes: readonly SecurityScanProbeLane[];
  readonly observations: readonly SecurityScanObservation[];
}

interface ParsedReport {
  readonly observations: readonly SecurityScanObservation[];
  readonly capped: boolean;
}

function unavailableLane(probe: SecurityScanProbe, code: "probe_unavailable" | "rules_unavailable", message: string): SecurityScanProbeLane {
  return { probe, state: "unavailable", observationCount: 0, coverage: "limited", error: { code, retryable: true, message } };
}

function failedLane(probe: SecurityScanProbe, code: "probe_failed" | "probe_output_invalid" | "probe_capped", message: string, retryable: boolean): SecurityScanProbeLane {
  return { probe, state: code === "probe_capped" ? "capped" : "failed", observationCount: 0, coverage: "limited", error: { code, retryable, message } };
}

function safeRuleId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(value) ? value : null;
}

function safePackageName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256 && !/\p{Cc}/u.test(normalized) ? normalized : null;
}

function safeSummary(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : fallback;
}

function safeLine(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

function relativeFindingPath(root: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
  const candidate = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const rel = relative(root, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const normalized = rel.split(sep).join("/");
  return normalized.split("/").some((part) => !part || part === "." || part === "..") ? null : normalized;
}

function severityFromText(value: unknown): SecurityScanObservation["severity"] {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  return normalized === "info" || normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "critical" ? normalized : "unknown";
}

function severityFromScore(value: unknown): SecurityScanObservation["severity"] {
  const score = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(score)) return "unknown";
  return score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : score > 0 ? "low" : "unknown";
}

function observationId(probe: SecurityScanProbe, ...parts: readonly string[]): string {
  const identity = createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 24);
  return `observation_${probe}_${identity}`;
}

function uniqueObservations(input: readonly SecurityScanObservation[]): ParsedReport {
  const observations: SecurityScanObservation[] = [];
  const ids = new Set<string>();
  for (const observation of input) {
    if (ids.has(observation.id)) continue;
    ids.add(observation.id);
    observations.push(observation);
  }
  return { observations, capped: false };
}

interface GitleaksFinding { readonly RuleID?: unknown; readonly File?: unknown; readonly StartLine?: unknown; readonly EndLine?: unknown }

export function parseGitleaksReport(
  root: string,
  raw: string,
  sourceScope: SecurityScanObservation["sourceScope"] = "current_tree",
): ParsedReport {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("probe_output_invalid"); }
  if (!Array.isArray(value)) throw new Error("probe_output_invalid");
  const observations: SecurityScanObservation[] = [];
  for (const finding of value) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) throw new Error("probe_output_invalid");
    const item = finding as GitleaksFinding;
    const ruleId = safeRuleId(item.RuleID);
    const startLine = safeLine(item.StartLine);
    const endLine = safeLine(item.EndLine) ?? startLine;
    const relativePath = relativeFindingPath(root, item.File);
    if (ruleId === null || startLine === null || endLine === null || endLine < startLine || relativePath === null) throw new Error("probe_output_invalid");
    observations.push(securityScanObservationSchema.parse({
      id: observationId("gitleaks", ruleId, relativePath, String(startLine), String(endLine)), probe: "gitleaks",
      sourceScope,
      ruleId, advisoryId: null, packageName: null, relativePath, startLine, endLine, severity: "high",
      summary: `Potential secret detected by Gitleaks rule ${ruleId}; the value was redacted.`, secretRedacted: true,
    }));
  }
  return uniqueObservations(observations);
}

interface OsvResult { readonly source?: { readonly path?: unknown }; readonly packages?: readonly unknown[] }

export function parseOsvScannerReport(root: string, raw: string): ParsedReport {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("probe_output_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("probe_output_invalid");
  const results = (value as { results?: unknown }).results;
  if (results !== undefined && !Array.isArray(results)) throw new Error("probe_output_invalid");
  const observations: SecurityScanObservation[] = [];
  for (const rawResult of results ?? []) {
    if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) throw new Error("probe_output_invalid");
    const result = rawResult as OsvResult;
    const relativePath = relativeFindingPath(root, result.source?.path);
    if (!Array.isArray(result.packages)) throw new Error("probe_output_invalid");
    for (const rawPackage of result.packages) {
      if (!rawPackage || typeof rawPackage !== "object" || Array.isArray(rawPackage)) throw new Error("probe_output_invalid");
      const entry = rawPackage as { package?: unknown; groups?: unknown };
      if (!entry.package || typeof entry.package !== "object" || Array.isArray(entry.package) || !Array.isArray(entry.groups)) throw new Error("probe_output_invalid");
      const pkg = entry.package as { name?: unknown; version?: unknown };
      const packageName = safePackageName(pkg.name);
      const version = safePackageName(pkg.version);
      if (packageName === null || version === null) throw new Error("probe_output_invalid");
      for (const rawGroup of entry.groups) {
        if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) throw new Error("probe_output_invalid");
        const group = rawGroup as { ids?: unknown; aliases?: unknown; max_severity?: unknown };
        const candidates: unknown[] = [];
        const ids = Array.isArray(group.ids) ? group.ids as readonly unknown[] : [];
        const aliases = Array.isArray(group.aliases) ? group.aliases as readonly unknown[] : [];
        for (const candidate of ids) candidates.push(candidate);
        for (const candidate of aliases) candidates.push(candidate);
        const advisoryId = candidates.map(safeRuleId).find((id): id is string => id !== null);
        if (advisoryId === undefined) throw new Error("probe_output_invalid");
        observations.push(securityScanObservationSchema.parse({
          id: observationId("osv_scanner", advisoryId, packageName, version, relativePath ?? ""), probe: "osv_scanner",
          ruleId: null, advisoryId, packageName, relativePath, startLine: null, endLine: null,
          severity: severityFromScore(group.max_severity), summary: `${packageName}@${version} is affected by ${advisoryId}.`, secretRedacted: false,
        }));
      }
    }
  }
  return uniqueObservations(observations);
}

export function parseTrivyReport(root: string, raw: string): ParsedReport {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("probe_output_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("probe_output_invalid");
  const results = (value as { Results?: unknown }).Results;
  if (results !== undefined && results !== null && !Array.isArray(results)) throw new Error("probe_output_invalid");
  const observations: SecurityScanObservation[] = [];
  for (const rawResult of results ?? []) {
    if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) throw new Error("probe_output_invalid");
    const result = rawResult as { Target?: unknown; Vulnerabilities?: unknown; Misconfigurations?: unknown };
    const relativePath = relativeFindingPath(root, result.Target);
    const vulnerabilities = result.Vulnerabilities ?? [];
    const misconfigurations = result.Misconfigurations ?? [];
    if (!Array.isArray(vulnerabilities) || !Array.isArray(misconfigurations)) throw new Error("probe_output_invalid");
    for (const rawFinding of vulnerabilities) {
      if (!rawFinding || typeof rawFinding !== "object" || Array.isArray(rawFinding)) throw new Error("probe_output_invalid");
      const finding = rawFinding as { VulnerabilityID?: unknown; PkgName?: unknown; InstalledVersion?: unknown; Severity?: unknown; Title?: unknown };
      const advisoryId = safeRuleId(finding.VulnerabilityID);
      const packageName = safePackageName(finding.PkgName);
      if (advisoryId === null || packageName === null) throw new Error("probe_output_invalid");
      const version = safePackageName(finding.InstalledVersion);
      observations.push(securityScanObservationSchema.parse({
        id: observationId("trivy", advisoryId, packageName, version ?? "", relativePath ?? ""), probe: "trivy",
        ruleId: null, advisoryId, packageName, relativePath, startLine: null, endLine: null, severity: severityFromText(finding.Severity),
        summary: safeSummary(finding.Title, `${packageName}${version ? `@${version}` : ""} is affected by ${advisoryId}.`), secretRedacted: false,
      }));
    }
    for (const rawFinding of misconfigurations) {
      if (!rawFinding || typeof rawFinding !== "object" || Array.isArray(rawFinding)) throw new Error("probe_output_invalid");
      const finding = rawFinding as { ID?: unknown; Title?: unknown; Severity?: unknown; CauseMetadata?: unknown };
      const ruleId = safeRuleId(finding.ID);
      if (ruleId === null) throw new Error("probe_output_invalid");
      const cause = finding.CauseMetadata && typeof finding.CauseMetadata === "object" && !Array.isArray(finding.CauseMetadata) ? finding.CauseMetadata as { StartLine?: unknown; EndLine?: unknown } : undefined;
      const startLine = safeLine(cause?.StartLine);
      const endLine = safeLine(cause?.EndLine) ?? startLine;
      observations.push(securityScanObservationSchema.parse({
        id: observationId("trivy", ruleId, relativePath ?? "", String(startLine ?? ""), String(endLine ?? "")), probe: "trivy",
        ruleId, advisoryId: null, packageName: null, relativePath, startLine, endLine, severity: severityFromText(finding.Severity),
        summary: safeSummary(finding.Title, `Trivy configuration rule ${ruleId} matched.`), secretRedacted: false,
      }));
    }
  }
  return uniqueObservations(observations);
}

export function parseSemgrepReport(root: string, raw: string): ParsedReport {
  const start = raw.indexOf("{");
  if (start < 0) throw new Error("probe_output_invalid");
  let value: unknown;
  try { value = JSON.parse(raw.slice(start)); } catch { throw new Error("probe_output_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("probe_output_invalid");
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results)) throw new Error("probe_output_invalid");
  const observations: SecurityScanObservation[] = [];
  for (const rawFinding of results) {
    if (!rawFinding || typeof rawFinding !== "object" || Array.isArray(rawFinding)) throw new Error("probe_output_invalid");
    const finding = rawFinding as { check_id?: unknown; path?: unknown; start?: unknown; end?: unknown; extra?: unknown };
    const ruleId = safeRuleId(finding.check_id);
    const relativePath = relativeFindingPath(root, finding.path);
    const startLine = finding.start && typeof finding.start === "object" && !Array.isArray(finding.start) ? safeLine((finding.start as { line?: unknown }).line) : null;
    const endLine = finding.end && typeof finding.end === "object" && !Array.isArray(finding.end) ? safeLine((finding.end as { line?: unknown }).line) ?? startLine : startLine;
    if (ruleId === null || relativePath === null || startLine === null || endLine === null || endLine < startLine) throw new Error("probe_output_invalid");
    const extra = finding.extra && typeof finding.extra === "object" && !Array.isArray(finding.extra) ? finding.extra as { message?: unknown; severity?: unknown } : undefined;
    observations.push(securityScanObservationSchema.parse({
      id: observationId("semgrep", ruleId, relativePath, String(startLine), String(endLine)), probe: "semgrep",
      ruleId, advisoryId: null, packageName: null, relativePath, startLine, endLine, severity: severityFromText(extra?.severity),
      summary: safeSummary(extra?.message, `Semgrep rule ${ruleId} matched.`), secretRedacted: false,
    }));
  }
  return uniqueObservations(observations);
}

export async function runSecurityProbeProcess(request: SecurityProbeProcessRequest): Promise<SecurityProbeProcessResult> {
  if (request.signal?.aborted) return { exitCode: null, cancelled: true, timedOut: false };
  const stdout = request.stdoutPath ? await fsPromises.open(request.stdoutPath, "wx", 0o600) : undefined;
  try { return await new Promise<SecurityProbeProcessResult>((resolveProcess, reject) => {
    const child = spawn(request.executablePath, [...request.argv], {
      cwd: request.cwd, detached: process.platform !== "win32",
      env: { PATH: "/usr/bin:/bin", HOME: "", ...request.environment },
      stdio: ["ignore", stdout?.fd ?? "ignore", "ignore"],
    });
    let cancelled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (force = false) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const childSignal = force ? "SIGKILL" : "SIGTERM";
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, childSignal);
        else child.kill(childSignal);
      } catch { child.kill(childSignal); }
      if (!force) { killTimer = setTimeout(() => terminate(true), 1_000); killTimer.unref?.(); }
    };
    const onAbort = () => { cancelled = true; terminate(); };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    const cleanup = () => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      request.signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (exitCode) => {
      cleanup();
      resolveProcess({ exitCode, cancelled, timedOut: false });
    });
  }); } finally { await stdout?.close(); }
}

interface ProbeRun {
  readonly probe: SecurityScanProbe;
  readonly executable: SecurityProbeEngineResolution;
  readonly argv: readonly string[];
  readonly reportPath: string;
  readonly root: string;
  readonly signal?: AbortSignal;
  readonly environment?: Readonly<Record<string, string>>;
  readonly stdoutPath?: string;
  readonly acceptedExitCodes?: readonly number[];
  readonly parse: (root: string, raw: string) => ParsedReport;
  readonly runProcess: (request: SecurityProbeProcessRequest) => Promise<SecurityProbeProcessResult>;
}

class ProbeReportError extends Error {
  constructor(readonly observations: readonly SecurityScanObservation[]) { super("probe_output_invalid"); }
}

/** Stream result groups, releasing raw siblings after normalization. No total report cap. */
export async function parseSecurityProbeReportFile(input: Pick<ProbeRun, "probe" | "root" | "reportPath" | "parse" | "signal">): Promise<ParsedReport> {
  const arrayRoot = input.probe === "gitleaks";
  const field = input.probe === "trivy" ? "Results" : "results";
  const observations: SecurityScanObservation[] = [];
  const parser = new JSONParser({
    paths: arrayRoot ? ["$.*"] : [`$.${field}.*`, `$.${field}`],
    keepStack: false,
  });
  let foundResults = false;
  parser.onValue = ({ value, key, parent }) => {
    if (!arrayRoot && key === field) {
      if (!Array.isArray(value) && !(input.probe === "trivy" && value === null)) throw new Error("probe_output_invalid");
      foundResults = true;
    } else {
      const wrapped = arrayRoot ? [value] : { [field]: [value] };
      for (const observation of input.parse(input.root, JSON.stringify(wrapped)).observations) observations.push(observation);
    }
    // Selecting the array for shape validation otherwise retains its siblings.
    // The parser documents parent as a live reference; release each raw group.
    if (parent && key !== undefined) delete (parent as Record<string, unknown>)[String(key)];
  };
  let started = false;
  try {
    for await (const raw of createReadStream(input.reportPath, { signal: input.signal })) {
      input.signal?.throwIfAborted();
      let chunk = raw as Buffer;
      if (!started) {
        // Semgrep may print a progress banner before JSON; preserve its existing contract.
        const first = input.probe === "semgrep" ? chunk.indexOf(123)
          : chunk.findIndex((byte) => ![9, 10, 13, 32].includes(byte));
        if (first < 0) continue;
        chunk = chunk.subarray(first);
        if (chunk[0] !== (arrayRoot ? 91 : 123)) throw new Error("probe_output_invalid");
        started = true;
      }
      parser.write(chunk);
    }
    if (!started) throw new Error("probe_output_invalid");
    if (!parser.isEnded) parser.end();
    if (input.probe === "semgrep" && !foundResults) throw new Error("probe_output_invalid");
    return uniqueObservations(observations);
  } catch {
    input.signal?.throwIfAborted();
    throw new ProbeReportError(uniqueObservations(observations).observations);
  }
}

async function executeProbe(input: ProbeRun): Promise<{ lane: SecurityScanProbeLane; observations: readonly SecurityScanObservation[] }> {
  if (input.executable.state !== "ready" || input.executable.internalPath === null) return { lane: unavailableLane(input.probe, "probe_unavailable", `${input.probe} probe is unavailable.`), observations: [] };
  try {
    const outcome = await input.runProcess({ executablePath: input.executable.internalPath, argv: input.argv, cwd: input.root, signal: input.signal, ...(input.environment ? { environment: input.environment } : {}), ...(input.stdoutPath ? { stdoutPath: input.stdoutPath } : {}) });
    if (outcome.cancelled || input.signal?.aborted) return { lane: { probe: input.probe, state: "cancelled", observationCount: 0, coverage: "limited", error: null }, observations: [] };
    if (outcome.timedOut) return { lane: failedLane(input.probe, "probe_capped", `${input.probe} reached its time limit.`, true), observations: [] };
    // OSV documents 128 as no packages found, not a crashed scanner. Keep
    // dependency coverage unavailable and explain why a blind retry cannot help.
    if (input.probe === "osv_scanner" && outcome.exitCode === 128) return {
      lane: { probe: input.probe, state: "unavailable", observationCount: 0, coverage: "limited", error: {
        code: "probe_unavailable", retryable: false,
        message: "OSV found no supported package sources in the target. Dependency vulnerability coverage is unavailable; no dependencies were verified.",
      } },
      observations: [],
    };
    if (!(input.acceptedExitCodes ?? [0]).includes(outcome.exitCode ?? -1)) return { lane: failedLane(input.probe, "probe_failed", `${input.probe} did not complete successfully.`, true), observations: [] };
    const info = await stat(input.reportPath);
    if (!info.isFile()) throw new Error("probe_output_invalid");
    const parsed = await parseSecurityProbeReportFile(input);
    return {
      lane: parsed.capped ? { probe: input.probe, state: "capped", observationCount: parsed.observations.length, coverage: "limited", error: { code: "probe_capped", retryable: false, message: `${input.probe} findings reached the safe result limit.` } } : { probe: input.probe, state: "completed", observationCount: parsed.observations.length, coverage: "limited", error: null },
      observations: parsed.observations,
    };
  } catch (error) {
    if (error instanceof ProbeReportError) return {
      lane: { ...failedLane(input.probe, "probe_output_invalid", `${input.probe} output was invalid or incomplete; retained sanitized observations are partial.`, true), observationCount: error.observations.length },
      observations: error.observations,
    };
    const cancelled = input.signal?.aborted === true;
    return { lane: cancelled ? { probe: input.probe, state: "cancelled", observationCount: 0, coverage: "limited", error: null } : failedLane(input.probe, error instanceof Error && error.message === "probe_output_invalid" ? "probe_output_invalid" : "probe_failed", `${input.probe} output could not be admitted safely.`, true), observations: [] };
  }
}

async function executeGitleaks(
  root: string,
  executable: SecurityProbeEngineResolution,
  treeReportPath: string,
  historyReportPath: string,
  runProcess: (request: SecurityProbeProcessRequest) => Promise<SecurityProbeProcessResult>,
  signal?: AbortSignal,
): Promise<{ lane: SecurityScanProbeLane; observations: readonly SecurityScanObservation[] }> {
  const shared = { probe: "gitleaks" as const, executable, root, ...(signal ? { signal } : {}), runProcess };
  const tree = executeProbe({
    ...shared,
    parse: (parseRoot, raw) => parseGitleaksReport(parseRoot, raw, "current_tree"),
    reportPath: treeReportPath,
    argv: ["dir", "--report-format", "json", "--report-path", treeReportPath, "--exit-code", "0", "--redact=100", "--no-banner", "--no-color", root],
  });
  const hasGitHistory = await stat(join(root, ".git")).then(() => true, () => false);
  const history = hasGitHistory
    ? executeProbe({
        ...shared,
        parse: (parseRoot, raw) => parseGitleaksReport(parseRoot, raw, "git_history"),
        reportPath: historyReportPath,
        argv: ["git", "--report-format", "json", "--report-path", historyReportPath, "--exit-code", "0", "--redact=100", "--no-banner", "--no-color", root],
      })
    : null;
  const executions = history === null ? [await tree] : await Promise.all([tree, history]);
  const combined = uniqueObservations(executions.flatMap((execution) => execution.observations));
  const states = new Set(executions.map((execution) => execution.lane.state));
  if (states.has("cancelled")) return { lane: { probe: "gitleaks", state: "cancelled", observationCount: combined.observations.length, coverage: "limited", error: null }, observations: combined.observations };
  if (states.has("unavailable")) return { lane: unavailableLane("gitleaks", "probe_unavailable", "Gitleaks is unavailable."), observations: [] };
  if (states.has("failed")) {
    const invalid = executions.some((execution) => execution.lane.error?.code === "probe_output_invalid");
    return { lane: { ...failedLane("gitleaks", invalid ? "probe_output_invalid" : "probe_failed", "Gitleaks current-tree or history scanning did not complete; retained sanitized observations are partial.", true), observationCount: combined.observations.length }, observations: combined.observations };
  }
  if (states.has("capped") || combined.capped) return { lane: { probe: "gitleaks", state: "capped", observationCount: combined.observations.length, coverage: "limited", error: { code: "probe_capped", retryable: false, message: "Gitleaks current-tree or history findings reached the safe result limit." } }, observations: combined.observations };
  return { lane: { probe: "gitleaks", state: "completed", observationCount: combined.observations.length, coverage: "limited", error: null }, observations: combined.observations };
}

function semgrepTargets(root: string): string {
  return JSON.stringify(["Scanning_roots", { root_paths: [root], targeting_conf: {
    exclude: ["node_modules", ".git", "dist", "build", "coverage", "vendor"], max_target_bytes: 0,
    respect_gitignore: true, respect_semgrepignore_files: true, always_select_explicit_targets: false,
    explicit_targets: [], force_novcs_project: false, exclude_minified_files: true,
    extra_gitignore_patterns_to_exclude_git_untracked_files: [], include_binary_files: false,
  } }]);
}

export async function runSecurityProbeSuite(root: string, deps: SecurityProbeSuiteDeps, signal?: AbortSignal, reportProgress?: (progress: SecurityScanProgress) => void): Promise<SecurityProbeSuiteResult> {
  const scratch = join(deps.scratchRoot, `scan-${randomUUID()}`);
  const cache = join(deps.cacheRoot, "v1");
  await mkdir(scratch, { recursive: false, mode: 0o700 });
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const runProcess = deps.runProcess ?? runSecurityProbeProcess;
  try {
    reportProgress?.({ stage: "preparing_scanners" });
    const [gitleaks, osv, trivy, semgrep, rules] = await Promise.all([
      deps.resolveGitleaks(signal), deps.resolveOsvScanner(signal), deps.resolveTrivy(signal), deps.resolveSemgrep(signal), deps.resolveSemgrepRules(signal),
    ]);
    const targetsPath = join(scratch, "semgrep-targets.json");
    await writeFile(targetsPath, semgrepTargets(root), { flag: "wx", mode: 0o600 });
    const reports = { gitleaksTree: join(scratch, "gitleaks-tree.json"), gitleaksHistory: join(scratch, "gitleaks-history.json"), osv: join(scratch, "osv.json"), trivy: join(scratch, "trivy.json"), semgrep: join(scratch, "semgrep.json") };
    const semgrepRules = rules.state === "ready" && rules.internalPath !== null ? join(rules.internalPath, SEMGREP_RULES_RELATIVE_PATH) : null;
    const observedProcess = (probe: SecurityScanProbe): typeof runProcess => async (request) => {
      reportProgress?.({ stage: "scanner_started", probe });
      const result = await runProcess(request);
      reportProgress?.({ stage: "scanner_finished", probe });
      return result;
    };
    const executions = await Promise.all([
      executeGitleaks(root, gitleaks, reports.gitleaksTree, reports.gitleaksHistory, observedProcess("gitleaks"), signal),
      executeProbe({
        probe: "osv_scanner", executable: osv, root, ...(signal ? { signal } : {}), reportPath: reports.osv, runProcess: observedProcess("osv_scanner"),
        // Only dependency names/versions reach the fixed OSV advisory service;
        // source bytes never do. Package-manager resolution is disabled.
        argv: ["scan", "source", "--recursive", "--no-resolve", "--format", "json", "--output-file", reports.osv, "--verbosity", "error", root],
        acceptedExitCodes: [0, 1], environment: { HOME: join(cache, "osv-home"), XDG_CACHE_HOME: join(cache, "osv-cache") }, parse: parseOsvScannerReport,
      }),
      executeProbe({
        probe: "trivy", executable: trivy, root, ...(signal ? { signal } : {}), reportPath: reports.trivy, runProcess: observedProcess("trivy"),
        argv: ["fs", "--scanners", "misconfig", "--skip-db-update", "--skip-java-db-update", "--skip-check-update", "--skip-version-check", "--disable-telemetry", "--offline-scan", "--cache-dir", join(cache, "trivy"), "--format", "json", "--output", reports.trivy, "--quiet", root],
        environment: { HOME: join(cache, "trivy-home"), XDG_CACHE_HOME: join(cache, "trivy-cache") }, parse: parseTrivyReport,
      }),
      semgrepRules === null ? Promise.resolve({ lane: unavailableLane("semgrep", "rules_unavailable", "Semgrep approved rules are unavailable."), observations: [] as readonly SecurityScanObservation[] }) : executeProbe({
        probe: "semgrep", executable: semgrep, root, ...(signal ? { signal } : {}), reportPath: reports.semgrep, stdoutPath: reports.semgrep, runProcess: observedProcess("semgrep"),
        argv: ["-rules", semgrepRules, "-targets", targetsPath, "-json", "-timeout", "0", "-timeout_threshold", "0", "-max_memory", "2048", "-j", "2"],
        environment: { HOME: join(cache, "semgrep-home") }, parse: parseSemgrepReport,
      }),
    ]);
    const observations = executions.flatMap((execution) => execution.observations);
    const lanes = executions.map((execution): SecurityScanProbeLane => ({
      ...execution.lane,
      observationCount: execution.observations.length,
    }));
    return { lanes, observations };
  } finally { await rm(scratch, { recursive: true, force: true }).catch(() => undefined); }
}
