import { agentBrowserArgv } from "@nautilo/relay";
import {
  agentBrowserPageReadAccessibilitySnapshotArgv,
  type BrowserPageReadDispatchDeps,
} from "./browser-page-read-dispatch.ts";
import { parseAgentBrowserAccessibilitySnapshotEnvelope } from "./rendered-page-extractor.ts";

export type BrowserResearchCookieAction =
  | "continue_without_accepting"
  | "reject_optional"
  | "necessary_only"
  | "dismiss"
  | "minimum_acceptance";

export interface BrowserResearchCookieWallResult {
  readonly observed: boolean;
  readonly acted: boolean;
  readonly action?: BrowserResearchCookieAction;
}

interface CookieControl {
  readonly ref: string;
  readonly label: string;
  readonly insideConsentDialog: boolean;
}

interface ObservedRoutineCookieWall {
  readonly observed: boolean;
  readonly control?: CookieControl & { action: BrowserResearchCookieAction };
}

const CONSENT_CONTEXT = /\b(?:cookie(?:s)?|consent|privacy (?:choice|choices|preference|preferences|settings)|tracking|legitimate interest|data partners?|vendors?|confidentialit[ée]|datenschutz|einwilligung|privacidad|consentimiento|privacidade|consentimento|toestemming)\b/i;
const MATERIAL_CONTEXT = /\b(?:age|adult|minor|terms|contract|purchase|checkout|payment|subscribe|sign[ -]?in|log[ -]?in|identity|medical|health)\b/i;
const CHALLENGE_CONTEXT = /\b(?:captcha|verify\s+(?:you\s+are\s+)?human|unusual\s+traffic|robot\s+check|security\s+check)\b/i;
const NON_INTERACTIVE_CONTROL = /(?:\[(?:disabled|hidden|inert)\]|\b(?:aria-)?disabled\s*(?:=|:)\s*["']?(?:true|1)["']?\b|\baria-hidden\s*(?:=|:)\s*["']?(?:true|1)["']?\b)/i;
const CONSENT_ACTION_SETTLE_MS = 750;

const LABEL_PRIORITY: ReadonlyArray<{
  readonly action: BrowserResearchCookieAction;
  readonly patterns: readonly RegExp[];
}> = [
  {
    action: "continue_without_accepting",
    patterns: [
      /^continue without (?:accepting|agreeing|consent)$/i,
      /^(?:browse|use (?:the )?site) without (?:accepting|agreeing|consent)$/i,
      /^continu(?:e|ar) (?:sans|sin|sem) (?:accepter|aceptar|aceitar|consentir)$/i,
      /^ohne (?:zustimmung|einwilligung) fortfahren$/i,
      /^doorgaan zonder (?:te )?(?:accepteren|toestemming)$/i,
      /\b(?:continue|browse|proceed)\b.*\bwithout\b.*\b(?:accept|agree|consent|cookies?)\b/i,
    ],
  },
  {
    action: "reject_optional",
    patterns: [
      /^reject (?:all|optional|non[- ]essential)(?: cookies)?$/i,
      /^decline (?:all|optional|non[- ]essential)(?: cookies)?$/i,
      /^(?:reject|decline) cookies$/i,
      /^do not (?:accept|allow)(?: optional| non[- ]essential)?(?: cookies)?$/i,
      /^opt out(?: of all)?$/i,
      /^(?:tout refuser|refuser tout)$/i,
      /^alle (?:cookies )?ablehnen$/i,
      /^rechazar(?: las)? (?:cookies )?(?:opcionales|no esenciales|todas?)$/i,
      /^rejeitar (?:os )?(?:cookies )?(?:opcionais|não essenciais|todos?)$/i,
      /^rifiuta (?:tutti i )?cookie$/i,
      /^(?:alle cookies|alles) weigeren$/i,
      /\b(?:reject|decline|refuse|deny|opt out)\b.*\b(?:cookies?|optional|non[- ]essential|tracking|analytics)\b/i,
    ],
  },
  {
    action: "necessary_only",
    patterns: [
      /^(?:allow|accept|use) (?:only )?(?:necessary|required|essential)(?: cookies)?(?: only)?$/i,
      /^(?:necessary|required|essential)(?: cookies)? only$/i,
      /^(?:accepter|autoriser) (?:uniquement )?(?:les )?(?:cookies )?(?:nécessaires|essentiels)$/i,
      /^(?:nur )?(?:notwendige|erforderliche|essenzielle) cookies (?:akzeptieren|zulassen)$/i,
      /^aceptar (?:solo )?(?:las )?(?:cookies )?(?:necesarias|esenciales)$/i,
      /^aceitar (?:apenas )?(?:os )?(?:cookies )?(?:necessários|essenciais)$/i,
      /^accetta (?:solo )?(?:i )?cookie (?:necessari|essenziali)$/i,
      /^(?:alleen )?noodzakelijke cookies (?:accepteren|toestaan)$/i,
      /\b(?:necessary|required|essential)\b.*\b(?:cookies?|only)\b/i,
    ],
  },
  {
    action: "dismiss",
    patterns: [/^(?:dismiss|close|not now|no thanks|fermer|pas maintenant|non merci|schließen|nicht jetzt|cerrar|ahora no|no, gracias|fechar|agora não|não, obrigado)$/i],
  },
  {
    action: "minimum_acceptance",
    patterns: [
      /^(?:save|confirm|apply) (?:my )?(?:choices|preferences|selection)$/i,
      /^(?:accept|allow) selected(?: cookies)?$/i,
      /^(?:accept|allow|agree to) all(?: cookies)?$/i,
      /^(?:enregistrer|confirmer|appliquer) (?:mes )?(?:choix|préférences|sélection)$/i,
      /^alle cookies akzeptieren$/i,
      /^accepter tous les cookies$/i,
      /^aceptar (?:todos? los|todas? las) cookies$/i,
      /^aceitar todos os cookies$/i,
      /^accetta (?:tutti i )?cookie$/i,
      /^(?:alle cookies|alles) accepteren$/i,
      /\b(?:accept|allow|agree)\b.*\b(?:all|cookies?)\b/i,
    ],
  },
];

function normalizedLabel(value: string): string {
  return value.normalize("NFKC").replace(/\\"/g, '"').replace(/\s+/g, " ").trim();
}

function comparableLabel(value: string): string {
  return normalizedLabel(value)
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex] ?? rightIndex;
      const next = left[leftIndex - 1] === right[rightIndex - 1]
        ? diagonal
        : 1 + Math.min(diagonal, above, previous[rightIndex - 1] ?? leftIndex);
      diagonal = above;
      previous[rightIndex] = next;
    }
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function nearLabelScore(requested: string, candidate: string): number {
  const left = comparableLabel(requested);
  const right = comparableLabel(candidate);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const longest = Math.max(left.length, right.length);
  const editSimilarity = longest < 8 ? 0 : 1 - editDistance(left, right) / longest;
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const tokenDice = leftTokens.size < 2 || rightTokens.size < 2
    ? 0
    : (2 * overlap) / (leftTokens.size + rightTokens.size);
  return Math.max(editSimilarity, tokenDice);
}

function selectRequestedConsentControl(
  controls: readonly CookieControl[],
  requestedLabel: string,
  deterministicRef?: string,
): CookieControl | undefined {
  const eligible = controls.filter((candidate) =>
    !MATERIAL_CONTEXT.test(candidate.label) &&
    (candidate.insideConsentDialog || deterministicRef === candidate.ref));
  const requested = comparableLabel(requestedLabel);
  const exact = eligible.find((candidate) => comparableLabel(candidate.label) === requested);
  if (exact) return exact;

  const ranked = eligible
    .map((candidate) => ({ candidate, score: nearLabelScore(requestedLabel, candidate.label) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best || best.score < 0.78 || (runnerUp && best.score - runnerUp.score < 0.08)) return undefined;
  return best.candidate;
}

function controlsFromSnapshot(snapshot: string): CookieControl[] {
  const controls: CookieControl[] = [];
  let consentDialogIndent: number | undefined;
  for (const line of snapshot.split("\n")) {
    const node = line.match(/^(\s*)-\s*(?:dialog|alertdialog|region)\s+"((?:\\.|[^"\\])*)"/i);
    const indent = line.match(/^(\s*)-/)?.[1]?.length;
    if (indent !== undefined && consentDialogIndent !== undefined && indent <= consentDialogIndent) consentDialogIndent = undefined;
    if (node?.[1] !== undefined && node[2] && looksLikeRoutineCookieWallText(normalizedLabel(node[2]))) {
      consentDialogIndent = node[1].length;
    }
    const match = line.match(/^\s*-\s*(?:button|link)\s+"((?:\\.|[^"\\])*)"([^\n]*)$/i);
    if (!match?.[1] || !match[2]) continue;
    if (NON_INTERACTIVE_CONTROL.test(match[2])) continue;
    const ref = match[2].match(/\bref=(e\d+)\b/i)?.[1];
    if (!ref) continue;
    const label = normalizedLabel(match[1]);
    if (label && label.length <= 160) controls.push({ label, ref, insideConsentDialog: consentDialogIndent !== undefined && indent !== undefined && indent > consentDialogIndent });
  }
  return controls;
}

export function routineCookieControls(snapshot: string): readonly { readonly reference: string; readonly label: string }[] {
  return controlsFromSnapshot(snapshot).map(({ ref, label }) => ({ reference: ref, label }));
}

/** Cookie handling is never a CAPTCHA workaround, even when a page mentions both. */
export function looksLikeRoutineCookieWallText(value: string): boolean {
  return CONSENT_CONTEXT.test(value) && !CHALLENGE_CONTEXT.test(value);
}

/** Pure, strict selector: no arbitrary page text or model-selected target reaches click. */
export function selectRoutineCookieControl(snapshot: string): (CookieControl & { action: BrowserResearchCookieAction }) | undefined {
  if (!looksLikeRoutineCookieWallText(snapshot)) return undefined;
  const controls = controlsFromSnapshot(snapshot);
  for (const group of LABEL_PRIORITY) {
    const selected = controls.find(({ label, insideConsentDialog }) =>
      !MATERIAL_CONTEXT.test(label) &&
      (insideConsentDialog || CONSENT_CONTEXT.test(label)) &&
      (group.action !== "dismiss" || insideConsentDialog) &&
      group.patterns.some((pattern) => pattern.test(label)));
    if (selected) return { ...selected, action: group.action };
  }
  return undefined;
}

async function inspectRoutineCookieWall(
  input: {
    readonly bin: string;
    readonly cfgPath: string;
    readonly session: string;
    readonly timeoutMs: number;
    readonly maxBuffer: number;
    readonly signal?: AbortSignal;
  },
  exec: BrowserPageReadDispatchDeps["exec"],
): Promise<ObservedRoutineCookieWall> {
  if (input.signal?.aborted || input.timeoutMs <= 0) return { observed: false };
  try {
    const captured = await exec(input.bin, agentBrowserPageReadAccessibilitySnapshotArgv(input.cfgPath, input.session), {
      timeout: input.timeoutMs,
      maxBuffer: input.maxBuffer,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    let envelope: unknown;
    try { envelope = JSON.parse(String(captured.stdout)); } catch { return { observed: false }; }
    const snapshot = parseAgentBrowserAccessibilitySnapshotEnvelope(envelope);
    if (!snapshot || !looksLikeRoutineCookieWallText(snapshot.snapshot)) return { observed: false };
    const controls = controlsFromSnapshot(snapshot.snapshot);
    const control = selectRoutineCookieControl(snapshot.snapshot);
    return {
      observed: controls.some((candidate) => candidate.insideConsentDialog) || control !== undefined,
      ...(control ? { control } : {}),
    };
  } catch {
    return { observed: false };
  }
}

async function settleRoutineCookieAction(
  input: Parameters<typeof inspectRoutineCookieWall>[0],
  exec: BrowserPageReadDispatchDeps["exec"],
): Promise<void> {
  if (input.signal?.aborted || input.timeoutMs <= 0) return;
  const milliseconds = Math.min(CONSENT_ACTION_SETTLE_MS, input.timeoutMs);
  try {
    await exec(
      input.bin,
      agentBrowserArgv("browser_wait", { milliseconds }, input.cfgPath, input.session),
      {
        timeout: Math.min(input.timeoutMs, milliseconds + 1_000),
        maxBuffer: 64 * 1024,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
  } catch {
    // Re-observation remains authoritative even if the bounded settle command fails.
  }
}

/** Re-observes without acting so a click cannot be reported as clearance merely because it returned. */
export async function observeRoutineCookieWall(
  input: Parameters<typeof inspectRoutineCookieWall>[0],
  exec: BrowserPageReadDispatchDeps["exec"],
): Promise<{ readonly observed: boolean }> {
  const observation = await inspectRoutineCookieWall(input, exec);
  return { observed: observation.observed };
}

/** One bounded autonomous pass against the exact anonymous research session. */
export async function clearRoutineCookieWall(
  input: {
    readonly bin: string;
    readonly cfgPath: string;
    readonly session: string;
    readonly timeoutMs: number;
    readonly maxBuffer: number;
    readonly signal?: AbortSignal;
  },
  exec: BrowserPageReadDispatchDeps["exec"],
): Promise<BrowserResearchCookieWallResult> {
  if (input.signal?.aborted) return { observed: false, acted: false };
  const deadline = Date.now() + input.timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  try {
    const snapshotTimeout = remaining();
    if (snapshotTimeout === 0) return { observed: false, acted: false };
    const observation = await inspectRoutineCookieWall(
      { ...input, timeoutMs: snapshotTimeout },
      exec,
    );
    const { observed, control } = observation;
    if (!control || input.signal?.aborted) return { observed, acted: false };
    const clickTimeout = remaining();
    if (clickTimeout === 0) return { observed, acted: false };
    await exec(input.bin, agentBrowserArgv("browser_click", { ref: control.ref }, input.cfgPath, input.session), {
      timeout: clickTimeout,
      maxBuffer: 64 * 1024,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await settleRoutineCookieAction({ ...input, timeoutMs: remaining() }, exec);
    return { observed: true, acted: true, action: control.action };
  } catch {
    return { observed: false, acted: false };
  }
}

/**
 * Replays one Genie-selected label against a fresh snapshot. The model never
 * supplies a selector or script: Electron resolves an exact visible label and
 * clicks only a button/link that is inside a consent surface (or is itself a
 * recognized consent control).
 */
export async function clickRoutineCookieControlByLabel(
  input: {
    readonly bin: string;
    readonly cfgPath: string;
    readonly session: string;
    readonly timeoutMs: number;
    readonly maxBuffer: number;
    readonly signal?: AbortSignal;
  },
  requestedLabel: string,
  exec: BrowserPageReadDispatchDeps["exec"],
): Promise<{ readonly acted: boolean }> {
  if (input.signal?.aborted) return { acted: false };
  try {
    const captured = await exec(
      input.bin,
      agentBrowserPageReadAccessibilitySnapshotArgv(input.cfgPath, input.session),
      {
        timeout: input.timeoutMs,
        maxBuffer: input.maxBuffer,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    let envelope: unknown;
    try { envelope = JSON.parse(String(captured.stdout)); } catch { return { acted: false }; }
    const snapshot = parseAgentBrowserAccessibilitySnapshotEnvelope(envelope);
    if (!snapshot || !looksLikeRoutineCookieWallText(snapshot.snapshot)) return { acted: false };
    const deterministic = selectRoutineCookieControl(snapshot.snapshot);
    const control = selectRequestedConsentControl(
      controlsFromSnapshot(snapshot.snapshot),
      requestedLabel,
      deterministic?.ref,
    );
    if (!control || input.signal?.aborted) return { acted: false };
    await exec(
      input.bin,
      agentBrowserArgv("browser_click", { ref: control.ref }, input.cfgPath, input.session),
      {
        timeout: input.timeoutMs,
        maxBuffer: 64 * 1024,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    await settleRoutineCookieAction(input, exec);
    return { acted: true };
  } catch {
    return { acted: false };
  }
}
