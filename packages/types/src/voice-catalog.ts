/** Verified language entry reported by ElevenLabs for a catalog voice. */
export type CatalogVerifiedLanguage = {
  language: string;
  modelId: string;
  accent: string | null;
  locale: string | null;
  previewUrl: string | null;
};

/** Normalized shared-voice row returned by `GET /api/voices/catalog`. */
export type CatalogVoice = {
  voiceId: string;
  name: string;
  accent: string;
  gender: string;
  age: string;
  descriptive: string;
  category: string;
  language: string;
  locale: string | null;
  languageLabel: string;
  previewUrl: string | null;
  verifiedLanguages: CatalogVerifiedLanguage[];
  /** provenance for badge semantics; curated voices are Nautilo-tested/trusted. */
  source: "provider" | "curated";
};

/** Language/locale grouping metadata for the catalog browser sidebar. */
export type CatalogLanguageGroup = {
  language: string;
  locale: string | null;
  label: string;
  count: number;
};

/** Query params for `GET /api/voices/catalog` (forwarded to ElevenLabs shared-voices). */
export type CatalogQuery = {
  language?: string;
  category?: "professional" | "famous" | "high_quality";
  gender?: string;
  age?: string;
  accent?: string;
  /** Comma-separated or single use-case slug(s). */
  use_cases?: string;
  search?: string;
  page?: number;
  page_size?: number;
};

/** Stable application envelope for the voice catalog proxy. */
export type CatalogResponse = {
  voices: CatalogVoice[];
  languageGroups: CatalogLanguageGroup[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  totalCount: number;
  elevenLabsConfigured: boolean;
  cachedAt: number | null;
  error?: string;
};

/** A Nautilo-curated voice safe to expose during Genie customization. */
export type CuratedVoice = {
  slug: string;
  label: string;
  voiceId: string;
  language: string;
  description: string;
  previewUrl: string;
};

/**
 * `GET /api/voices` hydration envelope for Genie customization.
 *
 * Authenticated non-guests receive the curated floor and the configuration
 * capability only. Owner/loopback callers additionally receive their
 * provider-account voice list for the existing Desktop path.
 */
export type VoiceCustomizationHydrationResponse = {
  curated: CuratedVoice[];
  voices: Array<{
    voiceId: string;
    name: string;
    labels: Record<string, string>;
    description: string | null;
  }>;
  elevenLabsConfigured: boolean;
  cachedAt: number | null;
  error?: string;
};

/** trust badge for discovery/audition tool results. */
export type VoiceDiscoveryBadge = "curated" | "provider_v3" | "provider_verified" | "unverified";

/** structured candidate from find_voice / audition_voices. */
export type VoiceDiscoveryCandidate = {
  voiceId: string;
  name: string;
  language: string;
  languageLabel: string;
  accent: string;
  gender: string;
  age: string;
  badge: VoiceDiscoveryBadge;
  previewUrl?: string | null;
  verifiedLanguages: CatalogVerifiedLanguage[];
  matchReason: string;
  honestyWarning?: string;
};

/** find_voice JSON envelope (LangChain tool returns a string). */
export type FindVoiceToolResult = {
  candidates: VoiceDiscoveryCandidate[];
  consideredCount: number;
  elevenLabsConfigured: boolean;
  warnings?: string[];
  error?: string;
};

/** audition_voices JSON envelope. */
export type AuditionVoicesToolResult = {
  slate: VoiceDiscoveryCandidate[];
  suggestedSlate?: boolean;
  consideredCount: number;
  role?: string;
  sampleText?: string;
  warnings?: string[];
  error?: string;
};

/**
 * Canonical Nautilo audition copy shared by desktop, mobile, and Agent tools.
 * Keep expressive cues intact: these samples introduce a person's Genie, not
 * a generic assistant or disposable system voice.
 */
export const GENIE_VOICE_SAMPLE_PHRASES: Readonly<Record<string, string>> = {
  af: "Hallo, ek is jou Genie. [laughs] Ek kan jou help dink, beplan en dinge maak.",
  en: "Hi, I'm your Genie. [laughs] I can help you think, plan, and make things.",
  ar: "مرحباً، أنا جنيّك. [laughs] يمكنني مساعدتك على التفكير والتخطيط وصنع الأشياء.",
  bg: "Здравей, аз съм твоят Джин. [laughs] Мога да ти помогна да мислиш, планираш и създаваш неща.",
  cs: "Ahoj, jsem tvůj Džin. [laughs] Pomůžu ti přemýšlet, plánovat a tvořit věci.",
  da: "Hej, jeg er din Genie. [laughs] Jeg kan hjælpe dig med at tænke, planlægge og skabe ting.",
  de: "Hallo, ich bin dein Genie. [laughs] Ich kann dir beim Denken, Planen und Erstellen helfen.",
  el: "Γεια, είμαι το Τζίνι σου. [laughs] Μπορώ να σε βοηθήσω να σκεφτείς, να σχεδιάσεις και να δημιουργήσεις πράγματα.",
  es: "Hola, soy tu Genio. [laughs] Puedo ayudarte a pensar, planificar y crear cosas.",
  fi: "Hei, olen sinun Geniesi. [laughs] Voin auttaa sinua ajattelemaan, suunnittelemaan ja luomaan asioita.",
  fil: "Kumusta, ako ang Genie mo. [laughs] Matutulungan kitang mag-isip, magplano, at gumawa ng mga bagay.",
  fr: "Bonjour, je suis ton Genie. [laughs] Je peux t'aider à réfléchir, planifier et créer des choses.",
  hi: "नमस्ते, मैं आपका जिनी हूं। [laughs] मैं सोचने, योजना बनाने और चीजें बनाने में आपकी मदद कर सकता हूं।",
  hr: "Bok, ja sam tvoj Duh. [laughs] Mogu ti pomoći razmišljati, planirati i stvarati stvari.",
  hu: "Szia, én vagyok a Dzsinid. [laughs] Segíthetek gondolkodni, tervezni és dolgokat alkotni.",
  id: "Hai, saya Genie-mu. [laughs] Saya bisa membantumu berpikir, merencanakan, dan membuat sesuatu.",
  it: "Ciao, sono il tuo Genio. [laughs] Posso aiutarti a pensare, pianificare e creare cose.",
  ja: "こんにちは、私はあなたのジーニーです。[laughs] 思考、計画、ものづくりをお手伝いできます。",
  ko: "안녕하세요, 저는 당신의 지니예요. [laughs] 생각하고, 계획하고, 무언가를 만드는 일을 도와드릴 수 있어요.",
  ms: "Hai, saya Genie anda. [laughs] Saya boleh membantu anda berfikir, merancang, dan mencipta sesuatu.",
  nl: "Hoi, ik ben je Genie. [laughs] Ik kan je helpen denken, plannen en dingen maken.",
  no: "Hei, jeg er din Genie. [laughs] Jeg kan hjelpe deg med å tenke, planlegge og lage ting.",
  pl: "Cześć, jestem twoim Dżinem. [laughs] Mogę pomóc ci myśleć, planować i tworzyć rzeczy.",
  pt: "Olá, sou o seu Gênio. [laughs] Posso ajudá-lo a pensar, planear e criar coisas.",
  ro: "Bună, sunt Geniul tău. [laughs] Te pot ajuta să gândești, să planifici și să creezi.",
  ru: "Привет, я твой Джин. [laughs] Я могу помочь тебе думать, планировать и создавать вещи.",
  sk: "Ahoj, som tvoj Džin. [laughs] Pomôžem ti premýšľať, plánovať a tvoriť veci.",
  sv: "Hej, jag är din Genie. [laughs] Jag kan hjälpa dig att tänka, planera och skapa saker.",
  ta: "வணக்கம், நான் உங்கள் ஜீனி. [laughs] சிந்திக்கவும், திட்டமிடவும், விஷயங்களை உருவாக்கவும் நான் உதவ முடியும்.",
  tr: "Merhaba, ben senin Cin'inim. [laughs] Düşünmene, plan yapmana ve bir şeyler üretmene yardımcı olabilirim.",
  uk: "Привіт, я твій Джин. [laughs] Я можу допомогти тобі думати, планувати й створювати речі.",
  vi: "Xin chào, tôi là Genie của bạn. [laughs] Tôi có thể giúp bạn suy nghĩ, lập kế hoạch và tạo ra mọi thứ.",
  zh: "你好，我是你的精灵。 [laughs] 我可以帮你思考、规划和创造。",
};

export function genieVoiceSampleTextForLanguage(language: string): string {
  const base = language.trim().toLowerCase().split("-")[0] || "en";
  return GENIE_VOICE_SAMPLE_PHRASES[base] ?? GENIE_VOICE_SAMPLE_PHRASES["en"]!;
}
