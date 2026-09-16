export const SERVER_FINISH_MODES = ["guide", "product"] as const;

export type ServerFinishMode = (typeof SERVER_FINISH_MODES)[number];

export type ServerCompletionBackend = "compose" | "railway";

export type ServerCompletionOutcome =
  | "complete"
  | "action-required"
  | "recoverable";

export type ServerBrowserOutcome = "opened" | "not-requested" | "failed";

export interface ServerCompletionDestinations {
  readonly serverUrl: string;
  readonly guideUrl: string;
  readonly productUrl: string;
  readonly finalUrl: string;
}

export interface ServerCompletionSummary {
  readonly schemaVersion: 1;
  readonly backend: ServerCompletionBackend;
  readonly operation: "deploy" | "resume";
  readonly outcome: ServerCompletionOutcome;
  readonly finish: ServerFinishMode;
  readonly destinations: ServerCompletionDestinations;
  readonly browser: ServerBrowserOutcome;
  readonly profile?: string | undefined;
  readonly launchId?: string | undefined;
  readonly payer?: "customer" | "nautilo-cloud" | undefined;
  readonly recoveryCode?:
    | "resume-exact-launch"
    | "resume-compose-owner"
    | "recover-compose-owner-result"
    | "restart-then-resume-owner"
    | "open-final-url"
    | "retry-browser-open"
    | undefined;
  readonly recoveryCommand?: string | undefined;
  readonly ownerSetup?:
    | "owner-bound"
    | "awaiting-owner"
    | "claim-active"
    | "install-unknown"
    | "target-unavailable"
    | "recovery-required"
    | undefined;
  readonly nextCommand?: string | undefined;
  readonly ownerSetupErrorCode?: string | undefined;
  readonly ownerResultPath?: string | undefined;
}

export function parseServerFinishMode(
  value: unknown,
  fallback: ServerFinishMode = "guide",
): ServerFinishMode {
  if (value === undefined) return fallback;
  if (value === "guide" || value === "product") return value;
  throw new Error("--finish must be either 'guide' or 'product'");
}

function canonicalServerUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("server completion URL is invalid");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error("server completion URL must be a credential-free HTTP(S) origin");
  }
  parsed.pathname = "/";
  return parsed;
}

export function resolveServerCompletionDestinations(
  serverUrl: string,
  finish: ServerFinishMode,
): ServerCompletionDestinations {
  const server = canonicalServerUrl(serverUrl);
  const product = new URL("/", server).toString();
  const guide = new URL("/help/server", server).toString();
  return {
    serverUrl: product.replace(/\/$/, ""),
    guideUrl: guide,
    productUrl: product,
    finalUrl: finish === "guide" ? guide : product,
  };
}

export function buildServerCompletionSummary(input: {
  readonly backend: ServerCompletionBackend;
  readonly operation: "deploy" | "resume";
  readonly outcome: ServerCompletionOutcome;
  readonly finish: ServerFinishMode;
  readonly serverUrl: string;
  readonly browser: ServerBrowserOutcome;
  readonly profile?: string | undefined;
  readonly launchId?: string | undefined;
  readonly payer?: "customer" | "nautilo-cloud" | undefined;
  readonly recoveryCode?: ServerCompletionSummary["recoveryCode"];
  readonly recoveryCommand?: string | undefined;
  readonly ownerSetup?: ServerCompletionSummary["ownerSetup"];
  readonly nextCommand?: string | undefined;
  readonly ownerSetupErrorCode?: string | undefined;
  readonly ownerResultPath?: string | undefined;
}): ServerCompletionSummary {
  return {
    schemaVersion: 1,
    backend: input.backend,
    operation: input.operation,
    outcome: input.outcome,
    finish: input.finish,
    destinations: resolveServerCompletionDestinations(input.serverUrl, input.finish),
    browser: input.browser,
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
    ...(input.payer === undefined ? {} : { payer: input.payer }),
    ...(input.recoveryCode === undefined ? {} : { recoveryCode: input.recoveryCode }),
    ...(input.recoveryCommand === undefined ? {} : { recoveryCommand: input.recoveryCommand }),
    ...(input.ownerSetup === undefined ? {} : { ownerSetup: input.ownerSetup }),
    ...(input.nextCommand === undefined ? {} : { nextCommand: input.nextCommand }),
    ...(input.ownerSetupErrorCode === undefined ? {} : { ownerSetupErrorCode: input.ownerSetupErrorCode }),
    ...(input.ownerResultPath === undefined ? {} : { ownerResultPath: input.ownerResultPath }),
  };
}

export function renderServerCompletionSummary(summary: ServerCompletionSummary): string {
  const status = summary.outcome === "complete"
    ? "complete"
    : summary.outcome === "action-required"
      ? "action required"
      : "recoverable";
  return [
    `Nautilo ${summary.backend} ${summary.operation}: ${status}`,
    `${summary.outcome === "complete"
      ? "Destination"
      : summary.ownerSetup === "recovery-required" ? "Server" : "Post-claim destination"}: ${summary.destinations.finalUrl}`,
    ...(summary.outcome === "complete"
      ? [summary.finish === "guide"
          ? "Next: sign in to continue server administration."
          : "Next: sign in to enter Nautilo."]
      : summary.nextCommand === undefined ? [] : [`Next: ${summary.nextCommand}`]),
    ...(summary.outcome !== "complete"
      ? [summary.browser === "opened"
          ? "Browser: owner setup opened."
          : summary.nextCommand === undefined
            ? "Browser: not required for this recovery."
            : "Browser: owner setup not opened; use the exact resume command above."]
      : summary.browser === "opened"
        ? ["Browser: opened"]
        : summary.browser === "failed"
          ? ["Browser: could not open; use the destination above."]
          : ["Browser: not opened; use the destination above."]),
    ...(summary.recoveryCommand === undefined || summary.recoveryCommand === summary.nextCommand
      ? []
      : [`Resume: ${summary.recoveryCommand}`]),
    ...(summary.ownerSetupErrorCode === undefined
      ? []
      : [`Owner setup error: ${summary.ownerSetupErrorCode}`]),
    ...(summary.ownerResultPath === undefined
      ? []
      : [`Owner recovery result: ${summary.ownerResultPath}`]),
    ...(summary.ownerSetup === "recovery-required"
      ? ["Recovery: the owner exists, but durable recovery codes are unavailable. Sign in with the permanent password and PIN from the protected owner config, then regenerate recovery codes in Security."]
      : []),
  ].join("\n") + "\n";
}
