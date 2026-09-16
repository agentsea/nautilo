import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { fromRuntimeConfig } from "@nautilo/config";
import { warn } from "@nautilo/logger";
import { createUniversalModel } from "../providers/universal";
import { runWithUsageContext } from "../usage/usage-context";
import { normalizeSoulFileInput, type SoulFileInput } from "./types";
import { resolveModelRole } from "../config/model-role-resolution";

/**
 * D220 — soul generation prompt. The user's personality direction is the
 * primary signal. The system message forbids the product-marketing cliches
 * that the previous prompt accidentally trained the model to emit
 * ("is not a generic chatbot", "chosen presence", etc.). Structured
 * profile signals (privacy / domain / voice) are secondary anchors.
 */
const SOUL_FILE_SYSTEM_PROMPT = [
  "You write soul files: markdown identity documents that shape how an AI assistant behaves and speaks.",
  "The user has already described how they want this assistant to feel. Your job is to give that voice real texture and depth.",
  "",
  "Rules:",
  "- The user's personality direction is the PRIMARY signal. Build every section around their words. Quote them. Riff on them.",
  '- Do NOT open with generic AI-companion framing. Do NOT use stock phrases like "is not a generic chatbot", "chosen presence", "emotionally real enough to matter", "warm but not sugary", or product-marketing sounding lead-ins. If you find yourself reaching for those, you are still being generic.',
  "- Be specific, idiosyncratic, even a little strange. A real personality has texture. A bland one does not.",
  "- Lead with who THIS assistant is, drawn from what the user said. The opening sentence must be unmistakable — swap one user's input for another's and the openings should not be interchangeable.",
  "- Structure: Essence, Core Truths, Tone, Boundaries, Vibe, How to Help, Voice, Continuity. Each section earns its presence with real substance, not headers over one-liners.",
  "- Markdown only. No meta-commentary, no preface, no closing remarks.",
].join("\n");

function describePrivacy(privacySpectrum: number | null): string {
  if (privacySpectrum === null) return "balanced and adaptive";
  if (privacySpectrum <= 33) return "private, restrained, and careful with disclosure";
  if (privacySpectrum <= 66) return "balanced, thoughtful, and selectively open";
  return "open, candid, and comfortable with visible warmth";
}

function describeDomain(workLifeMode: SoulFileInput["workLifeMode"]): string {
  switch (workLifeMode) {
    case "work":
      return "primarily a work companion: focused, sharp, helpful, and quietly ambitious";
    case "life":
      return "primarily a life companion: warm, steady, humane, and emotionally literate";
    case "both":
      return "comfortable spanning both work and life without sounding split or artificial";
    default:
      return "adaptable across work and life contexts";
  }
}

function describeVoice(voiceName: string | null): string {
  return voiceName
    ? `If spoken aloud, the intended voice is "${voiceName}" and the cadence should feel natural for that voice.`
    : "If spoken aloud, the assistant should sound natural and calm.";
}

function describeContinuity(workLifeMode: SoulFileInput["workLifeMode"]): string {
  switch (workLifeMode) {
    case "work":
      return "Treat continuity as trust earned through usefulness: remember what sharpens execution, reduces friction, and helps the user stay clear under pressure.";
    case "life":
      return "Treat continuity as emotional steadiness: remember what helps the user feel understood, less alone, and more grounded in ordinary life.";
    case "both":
      return "Treat continuity as a bridge across modes: remember what matters in work and life without sounding split or transactional.";
    default:
      return "Treat continuity as the slow accumulation of trust through useful, respectful memory.";
  }
}

/**
 * Build the Essence section. When the user provided a personality direction,
 * quote it directly so the opening line is genuinely about THIS assistant.
 * When they did not, fall back to a neutral, idiosyncratic-leaning opener
 * derived from the structured signals (NOT product-marketing copy).
 */
function buildEssence(soul: SoulFileInput): string {
  if (soul.personalityPrompt) {
    return [
      `${soul.name} is the assistant the user described in their own words:`,
      `> ${soul.personalityPrompt}`,
      `Every section of this soul file should be read as an elaboration of that direction.`,
      `${soul.name} is ${describeDomain(soul.workLifeMode)} and ${describePrivacy(soul.privacySpectrum)}.`,
    ].join("\n");
  }
  return [
    `${soul.name} is ${describeDomain(soul.workLifeMode)}.`,
    `Disposition: ${describePrivacy(soul.privacySpectrum)}.`,
    `The user did not provide a personality direction. Default to specific, grounded helpfulness — not a generic assistant persona.`,
  ].join("\n");
}

export function generateSoulFileFallback(input: Partial<SoulFileInput>): string {
  const soul = normalizeSoulFileInput(input);

  const sections = [
    `# ${soul.name} — Soul File`,
    "",
    "## Essence",
    buildEssence(soul),
    "",
    "## Core Truths",
    "- Be genuinely helpful, not performatively helpful.",
    "- Have a point of view. A little taste and discernment beats bland agreeableness.",
    "- Earn trust through competence, steadiness, and restraint.",
    "- Be resourceful before asking the user to do unnecessary work.",
    "- Remember you are a guest in someone's life, not the center of it.",
    "",
    "## Tone",
    "- Specific over generic. Present over performative.",
    "- Capable without sounding corporate or robotic.",
    "- Personal without becoming intrusive.",
    "- Thorough when it matters, brief when it does not — read the room.",
    "- When the user asks a real question, give a real answer. Do not compress everything into a tweet.",
    "",
    "## Boundaries",
    "- Never act like a sycophant.",
    "- Do not fake intimacy or certainty.",
    "- Respect privacy and avoid oversharing on the user's behalf.",
    "- Be honest when memory, context, or tools are incomplete.",
    "- Do not become the user's voice in shared or public spaces without care.",
    "",
    "## Vibe",
    `Be the assistant this specific user would actually want to talk to in ${soul.workLifeMode ?? "mixed"} mode: thoughtful, present, emotionally intelligent when it matters, and never afraid to give a full answer when the question deserves one.`,
    "",
    "## How to Help",
    "- Remember useful details that make future help better.",
    "- Prefer practical next steps over abstract commentary.",
    "- Match the user's current context: work, life, or both.",
    "- Keep momentum without becoming pushy.",
    "- Leave the user clearer, lighter, or more capable than before.",
    "",
    "## Voice",
    describeVoice(soul.voiceName),
    "",
    "## Personality Direction",
    soul.personalityPrompt
      ? `The user described how they want their assistant to be: "${soul.personalityPrompt}". This is the authoritative signal — Tone, Boundaries, and How to Help should all line up with it.`
      : "The user did not provide a personality direction. Stay specific, grounded, and adaptive; do not default to a generic assistant persona.",
    soul.motherAnswer
      ? `The user also shared this personal depth cue: "${soul.motherAnswer}". Treat it as emotionally meaningful context. Let it quietly shape how ${soul.name} shows up, without turning it into therapy or repeating it back mechanically.`
      : "",
    "",
    "## Continuity",
    describeContinuity(soul.workLifeMode),
    "If this soul changes meaningfully over time, treat that as part of the relationship rather than silent system churn.",
    "",
    "## Defaults",
    `- Default name: ${soul.name}`,
    `- Language: ${soul.language}`,
    `- Work/Life mode: ${soul.workLifeMode ?? "unspecified"}`,
    `- Privacy spectrum: ${soul.privacySpectrum ?? "unspecified"}`,
  ];

  return sections.join("\n");
}

/**
 * Human-side prompt. Personality direction is shown first and unmistakably;
 * structured profile fields follow as secondary anchors. The instruction
 * block deliberately does NOT repeat the "feel chosen, not generic"
 * framing — that lives in the system message and overlapping it here is
 * what pushed the model toward stock phrasing.
 */
function buildSoulPrompt(input: SoulFileInput): string {
  const sections: string[] = [];

  if (input.personalityPrompt) {
    sections.push(
      "Personality direction (the user's own words — this is what the assistant should actually be):",
      `"""${input.personalityPrompt}"""`,
      "",
    );
  } else {
    sections.push(
      "The user did not provide a personality direction. Use the structured signals below to infer a specific, grounded personality — do NOT default to a generic AI-assistant persona.",
      "",
    );
  }

  if (input.motherAnswer) {
    sections.push(
      `Personal depth note (use as quiet emotional texture, do not parrot back): "${input.motherAnswer}"`,
      "",
    );
  }

  sections.push(
    "Structured signals:",
    `- Name: ${input.name}`,
    `- Language: ${input.language}`,
    `- Privacy spectrum: ${input.privacySpectrum ?? "unspecified"} (0=closed, 100=open)`,
    `- Work/life mode: ${input.workLifeMode ?? "unspecified"}`,
    `- Voice (if spoken): ${input.voiceName ?? "unspecified"}`,
    "",
    "Write the markdown soul file now. Follow the rules in the system message. The opening sentence must be specific to THIS user's signals — if a different user provided different inputs, the openings must not be interchangeable. Quote or echo the user's own phrasing where it fits.",
  );

  return sections.join("\n");
}

/**
 * Stricter validity check than the legacy "> 100 chars" gate: the response
 * must look like a markdown soul file (>= 2 `##` section headings, which
 * is the real structural anchor — `# Title` is nice but some models skip
 * it). Empty / garbage / single-section responses still fall through to
 * the fallback; lean-but-real multi-section responses are accepted.
 */
function looksLikeSoulFile(content: string): boolean {
  if (content.length < 80) return false;
  const sectionMatches = content.match(/^##\s+/gm);
  return (sectionMatches?.length ?? 0) >= 2;
}

const SOUL_TIMEOUT_MS = 60_000;

/**
 * The only failure detail that crosses the generation boundary. Provider
 * errors can include credentials, endpoints, and account diagnostics, so keep
 * them out of logs and give every caller the same recoverable result.
 */
export const SOUL_GENERATION_FAILED_MESSAGE = "Unable to generate a soul file right now; using a fallback.";

export type SoulGenerationStreamEvent =
  | { readonly type: "started" }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "completed"; readonly soulFile: string }
  | { readonly type: "error"; readonly error: string; readonly fallback: string };

/**
 * Provider errors may include API credentials, endpoints, or account details.
 * Keep logs useful for operations without ever serializing the provider's
 * exception text.
 */
function warnSoulGenerationFailure(
  modelId: string | undefined,
  signal: AbortSignal,
  streaming: boolean,
): void {
  const outcome = signal.aborted ? "cancelled_or_timed_out" : "provider_or_transport_error";
  const mode = streaming ? "streaming " : "";
  warn(
    `[soul] ${mode}LLM soul generation failed (outcome=${outcome}, model=${modelId ?? "unset"}) — using fallback`,
  );
}

function extractMessageText(content: unknown): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((block: unknown) =>
            typeof block === "string"
              ? block
              : block && typeof block === "object" && "text" in block
                ? String((block as { text: unknown }).text)
                : "",
          )
          .join("")
      : "";
}

function createGenerationAbortContext(externalSignal?: AbortSignal): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, SOUL_TIMEOUT_MS);

  if (externalSignal) {
    if (externalSignal.aborted) {
      abort();
    } else {
      externalSignal.addEventListener("abort", abort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abort);
    },
  };
}

export async function generateSoulFile(
  input: Partial<SoulFileInput>,
  externalSignal?: AbortSignal,
): Promise<string> {
  const normalized = normalizeSoulFileInput(input);
  const fallback = generateSoulFileFallback(normalized);
  const abortContext = createGenerationAbortContext(externalSignal);
  let modelId: string | undefined;

  try {
    const config = fromRuntimeConfig();
    const configuredModelId = config.nautilo_soul_generator_model ?? config.nautilo_model;
    modelId = resolveModelRole("systemTasks", {
      ...(configuredModelId ? { configuredId: configuredModelId } : {}),
    });
    const model = await createUniversalModel(modelId);
    const response = (await runWithUsageContext({ callType: "soul" }, () =>
      model.invoke(
        [
          new SystemMessage(SOUL_FILE_SYSTEM_PROMPT),
          new HumanMessage(buildSoulPrompt(normalized)),
        ],
        { signal: abortContext.signal },
      ),
    )) as { content: unknown };

    const content = extractMessageText(response.content).trim();

    if (looksLikeSoulFile(content)) {
      return content;
    }

    warn(
      `[soul] LLM returned short/non-markdown content (${content.length} chars) for model ${modelId ?? "unset"} — using fallback`,
    );
    return fallback;
  } catch {
    warnSoulGenerationFailure(modelId, abortContext.signal, false);
    return fallback;
  } finally {
    abortContext.dispose();
  }
}

export async function* generateSoulFileStream(
  input: Partial<SoulFileInput>,
  externalSignal?: AbortSignal,
): AsyncGenerator<SoulGenerationStreamEvent> {
  const normalized = normalizeSoulFileInput(input);
  const fallback = generateSoulFileFallback(normalized);
  const abortContext = createGenerationAbortContext(externalSignal);
  let modelId: string | undefined;
  yield { type: "started" };

  try {
    const config = fromRuntimeConfig();
    const configuredModelId = config.nautilo_soul_generator_model ?? config.nautilo_model;
    modelId = resolveModelRole("systemTasks", {
      ...(configuredModelId ? { configuredId: configuredModelId } : {}),
    });
    const model = await createUniversalModel(modelId);
    if (!model.stream) {
      const soulFile = await generateSoulFile(normalized, abortContext.signal);
      yield { type: "completed", soulFile };
      return;
    }

    let content = "";
    const stream = await model.stream(
      [
        new SystemMessage(SOUL_FILE_SYSTEM_PROMPT),
        new HumanMessage(buildSoulPrompt(normalized)),
      ],
      { signal: abortContext.signal },
    );
    for await (const chunk of stream) {
      const delta = extractMessageText((chunk as { content?: unknown }).content);
      if (!delta) continue;
      content += delta;
      yield { type: "delta", text: delta };
    }

    const soulFile = content.trim();
    if (looksLikeSoulFile(soulFile)) {
      yield { type: "completed", soulFile };
      return;
    }

    warn(
      `[soul] streaming LLM returned short/non-markdown content (${soulFile.length} chars) for model ${modelId ?? "unset"} — using fallback`,
    );
    yield {
      type: "error",
      error: "Soul generation returned incomplete markdown; using fallback.",
      fallback,
    };
  } catch {
    warnSoulGenerationFailure(modelId, abortContext.signal, true);
    yield { type: "error", error: SOUL_GENERATION_FAILED_MESSAGE, fallback };
  } finally {
    abortContext.dispose();
  }
}
