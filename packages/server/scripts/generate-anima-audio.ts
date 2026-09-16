/**
 * Anima Onboarding Wizard — Audio Pre-Recording Script
 *
 * Generates all narrator audio files via ElevenLabs API (eleven_v3 model).
 * Output: public/audio/anima-setup/{lang}/{filename}.mp3
 *
 * Usage:
 *   ELEVENLABS_API_KEY=sk-... npx tsx scripts/generate-anima-audio.ts
 *   ELEVENLABS_API_KEY=sk-... npx tsx scripts/generate-anima-audio.ts --lang en
 *   ELEVENLABS_API_KEY=sk-... npx tsx scripts/generate-anima-audio.ts --lang es
 *   ELEVENLABS_API_KEY=sk-... npx tsx scripts/generate-anima-audio.ts --dry-run
 *
 * Model: eleven_v3 (Expressive) — supports audio tags for emotion, pauses, breath.
 *
 * Audio Tag Reference (eleven_v3 only):
 *   Emotions:  [excited] [nervous] [calm] [sorrowful] [frustrated]
 *   Reactions: [sigh] [laughs] [gulps] [gasps] [whispers] [happy gasp]
 *   Cognitive: [pauses] [hesitates] [stammers] [resigned tone]
 *   Tone:      [cheerfully] [flatly] [playfully] [warmly] [gently]
 *   Delivery:  [rushed] [slows down] [deliberate] [drawn out]
 *   Pauses:    [pause] [short pause] [long pause]
 *   Breath:    [breathes]
 *   Speed:     [rapid-fire]
 *   Emphasis:  [emphasized] [understated]
 *
 * SSML <break> tags are NOT supported in eleven_v3. Use [pause] tags instead.
 */

import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

const MODEL_ID = "eleven_v3";
const OUTPUT_FORMAT = "mp3_44100_128";
const BASE_URL = "https://api.elevenlabs.io";
const OUTPUT_DIR = join(process.cwd(), "apps", "web", "public", "audio", "anima-setup");

const VOICE_SETTINGS = {
  stability: 0.35,
  similarity_boost: 0.78,
  style: 0.4,
  use_speaker_boost: true,
};

// ---------- Voice IDs ----------
// TODO: Replace TBD IDs after running: curl -H "xi-api-key: $KEY" https://api.elevenlabs.io/v1/voices
const VOICES = {
  jessica: "cgSgspJ2msm6clMCkdW9",
  carolyn: "JSWO6cw2AyFE324d5kEr",
  beatriz: "gJlzF5JxsCvM5hQAoRyD",
} as const;

// ---------- Narrator Script ----------
// All lines use eleven_v3 audio tags for emotion, pauses, and delivery.

interface ScriptLine {
  id: string;
  filename: string;
  voiceId: string;
  text: string;
}

const EN_NARRATOR_LINES: ScriptLine[] = [
  // Screen 1 — Language (EN half only; ES half is separate, then we stitch)
  {
    id: "01-language-en",
    filename: "01-language-en-half.mp3",
    voiceId: VOICES.jessica,
    text: `[warmly] Hey! [short pause] Do you prefer English...`,
  },
  // Screen 2 — Privacy
  {
    id: "02-privacy",
    filename: "02-privacy.mp3",
    voiceId: VOICES.jessica,
    text: `[gently] Let's get to know each other. [pause] First — [playfully] are you more of a private person... [short pause] or an open book?`,
  },
  // Screen 3 — Companion Domain
  {
    id: "03-domain",
    filename: "03-domain.mp3",
    voiceId: VOICES.jessica,
    text: `[cheerfully] Nice. [short pause] Now — imagine me in your everyday life. [pause] Would I mostly help you with work — emails, research, documents? [short pause] Or would I be more at home — [warmly] playing music, setting the lights, keeping your life together? [pause] Or both?`,
  },
  // Screen 4 — Personality prompt (replaces mother as default)
  {
    id: "04-personality",
    filename: "04-personality.mp3",
    voiceId: VOICES.jessica,
    text: `[gently] Now, tell me — [pause] how would you like me to be? [short pause] What kind of assistant would actually help you? [pause] [warmly] Just say it in your own words.`,
  },
  {
    id: "04-personality-thanks",
    filename: "04-personality-thanks.mp3",
    voiceId: VOICES.jessica,
    text: `[warmly] [short pause] I hear you. I'll carry that with me.`,
  },
  {
    id: "04-personality-skip",
    filename: "04-personality-skip.mp3",
    voiceId: VOICES.jessica,
    text: `[cheerfully] That's okay — [short pause] we'll figure it out together as we go.`,
  },
  // Screen 4b — Mother question (easter egg, gated behind motherEasterEgg config flag)
  {
    id: "04-mother",
    filename: "04-mother.mp3",
    voiceId: VOICES.jessica,
    text: `[gently] One more thing... [long pause] and you can skip this one if you want. [pause] [softly] How do you feel about your mother?`,
  },
  {
    id: "04-mother-thanks",
    filename: "04-mother-thanks.mp3",
    voiceId: VOICES.jessica,
    text: `[warmly] [short pause] Thank you for sharing that.`,
  },
  {
    id: "04-mother-skip",
    filename: "04-mother-skip.mp3",
    voiceId: VOICES.jessica,
    text: `[cheerfully] No worries. [short pause] Let's keep going.`,
  },
  // Screen 5 — Compiling
  {
    id: "05-compiling",
    filename: "05-compiling.mp3",
    voiceId: VOICES.jessica,
    text: `[playfully] Alright, give me a moment... [pause] [excited] I'm putting myself together.`,
  },
  // Screen 6 — Avatar
  {
    id: "06-avatar",
    filename: "06-avatar.mp3",
    voiceId: VOICES.jessica,
    text: `[cheerfully] Now — what do you want me to look like? [short pause] [warmly] Pick one that speaks to you... or make your own.`,
  },
  // Screen 7 — Name
  {
    id: "07-name",
    filename: "07-name.mp3",
    voiceId: VOICES.jessica,
    text: `[gently] I need a name. [pause] You can pick one for me... [short pause] [playfully] or let me surprise you.`,
  },
  // Screen 8 — Voice
  {
    id: "08-voice",
    filename: "08-voice.mp3",
    voiceId: VOICES.jessica,
    text: `[excited] Last thing — [pause] what do you want me to sound like? [short pause] [playfully] Tap each one to hear me try it on.`,
  },
];

const ES_NARRATOR_LINES: ScriptLine[] = [
  // Screen 1 — Language (ES half)
  {
    id: "01-language-es",
    filename: "01-language-es-half.mp3",
    voiceId: VOICES.beatriz,
    text: `[warmly] ¿O prefieres hablar en español?`,
  },
  {
    id: "02-privacy",
    filename: "02-privacy.mp3",
    voiceId: VOICES.beatriz,
    text: `[gently] Vamos a conocernos. [pause] Primero — [playfully] ¿eres más una persona reservada... [short pause] o un libro abierto?`,
  },
  {
    id: "03-domain",
    filename: "03-domain.mp3",
    voiceId: VOICES.beatriz,
    text: `[cheerfully] Bien. [short pause] Ahora — imagíname en tu día a día. [pause] ¿Te ayudaría más con el trabajo — correos, investigación, documentos? [short pause] ¿O estaría más en tu casa — [warmly] poniendo música, ajustando las luces, organizando tu vida? [pause] ¿O las dos cosas?`,
  },
  // Screen 4 — Personality prompt
  {
    id: "04-personality",
    filename: "04-personality.mp3",
    voiceId: VOICES.beatriz,
    text: `[gently] Ahora, dime — [pause] ¿cómo te gustaría que sea? [short pause] ¿Qué tipo de asistente te ayudaría de verdad? [pause] [warmly] Dilo con tus propias palabras.`,
  },
  {
    id: "04-personality-thanks",
    filename: "04-personality-thanks.mp3",
    voiceId: VOICES.beatriz,
    text: `[warmly] [short pause] Te escucho. Lo voy a tener presente.`,
  },
  {
    id: "04-personality-skip",
    filename: "04-personality-skip.mp3",
    voiceId: VOICES.beatriz,
    text: `[cheerfully] Está bien — [short pause] lo iremos descubriendo juntos.`,
  },
  // Screen 4b — Mother easter egg
  {
    id: "04-mother",
    filename: "04-mother.mp3",
    voiceId: VOICES.beatriz,
    text: `[gently] Una cosa más... [long pause] y puedes saltarte esta si quieres. [pause] [softly] ¿Cómo te sientes respecto a tu madre?`,
  },
  {
    id: "04-mother-thanks",
    filename: "04-mother-thanks.mp3",
    voiceId: VOICES.beatriz,
    text: `[warmly] [short pause] Gracias por compartir eso.`,
  },
  {
    id: "04-mother-skip",
    filename: "04-mother-skip.mp3",
    voiceId: VOICES.beatriz,
    text: `[cheerfully] No te preocupes. [short pause] Sigamos.`,
  },
  {
    id: "05-compiling",
    filename: "05-compiling.mp3",
    voiceId: VOICES.beatriz,
    text: `[playfully] Un momento... [pause] [excited] me estoy armando.`,
  },
  {
    id: "06-avatar",
    filename: "06-avatar.mp3",
    voiceId: VOICES.beatriz,
    text: `[cheerfully] Ahora — ¿cómo quieres que me vea? [short pause] [warmly] Elige uno que te hable... o crea el tuyo.`,
  },
  {
    id: "07-name",
    filename: "07-name.mp3",
    voiceId: VOICES.beatriz,
    text: `[gently] Necesito un nombre. [pause] Puedes elegir uno para mí... [short pause] [playfully] o deja que te sorprenda.`,
  },
  {
    id: "08-voice",
    filename: "08-voice.mp3",
    voiceId: VOICES.beatriz,
    text: `[excited] Última cosa — [pause] ¿cómo quieres que suene? [short pause] [playfully] Toca cada una para escucharme probarla.`,
  },
];

// Voice audition samples — each voice says the same line
const EN_VOICE_SAMPLES: ScriptLine[] = [
  {
    id: "voice-carolyn",
    filename: "voices/carolyn-sample.mp3",
    voiceId: VOICES.carolyn,
    text: `[warmly] Hey there, [short pause] what do you think of this one?`,
  },
  {
    id: "voice-jessica",
    filename: "voices/jessica-sample.mp3",
    voiceId: VOICES.jessica,
    text: `[playfully] Hey there, [short pause] what do you think of this one?`,
  },
];

const ES_VOICE_SAMPLES: ScriptLine[] = [
  {
    id: "voice-beatriz",
    filename: "voices/beatriz-sample.mp3",
    voiceId: VOICES.beatriz,
    text: `[warmly] Hola, [short pause] ¿qué te parece esta?`,
  },
];

// ---------- API Call ----------

async function generateAudio(line: ScriptLine, lang: string): Promise<Buffer> {
  const apiKey = process.env["ELEVENLABS_API_KEY"];
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const url = `${BASE_URL}/v1/text-to-speech/${line.voiceId}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: line.text,
      model_id: MODEL_ID,
      output_format: OUTPUT_FORMAT,
      voice_settings: VOICE_SETTINGS,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `ElevenLabs API error for "${line.id}" (${response.status}): ${body}`
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

// ---------- Rate Limiter ----------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Main ----------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const langFilter = args.find((a) => a.startsWith("--lang="))?.split("=")[1];

  const allLines: Array<{ lang: string; lines: ScriptLine[] }> = [];

  if (!langFilter || langFilter === "en") {
    allLines.push({ lang: "en", lines: [...EN_NARRATOR_LINES, ...EN_VOICE_SAMPLES] });
  }
  if (!langFilter || langFilter === "es") {
    allLines.push({ lang: "es", lines: [...ES_NARRATOR_LINES, ...ES_VOICE_SAMPLES] });
  }

  let total = 0;
  let skipped = 0;

  for (const { lang, lines } of allLines) {
    const langDir = join(OUTPUT_DIR, lang);
    const voicesDir = join(langDir, "voices");
    await mkdir(langDir, { recursive: true });
    await mkdir(voicesDir, { recursive: true });

    for (const line of lines) {
      const outputPath = join(langDir, line.filename);
      total++;

      if (line.voiceId.startsWith("TBD")) {
        console.log(`⏭  [${lang}] ${line.id} — skipped (voice ID is TBD)`);
        skipped++;
        continue;
      }

      if (dryRun) {
        console.log(`🔇 [${lang}] ${line.id} → ${outputPath}`);
        console.log(`   Text: ${line.text.slice(0, 80)}...`);
        continue;
      }

      console.log(`🎙  [${lang}] Generating: ${line.id}...`);

      try {
        const buffer = await generateAudio(line, lang);
        await writeFile(outputPath, buffer);
        console.log(
          `   ✅ Saved: ${line.filename} (${(buffer.length / 1024).toFixed(1)}KB)`
        );
      } catch (err) {
        console.error(
          `   ❌ Failed: ${line.id} — ${(err as Error).message}`
        );
      }

      // Rate limit: ~2 requests/second to stay within ElevenLabs limits
      await delay(600);
    }
  }

  console.log(`\nDone. ${total} lines processed, ${skipped} skipped (TBD voice IDs).`);
  if (dryRun) console.log("(dry run — no audio generated)");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
