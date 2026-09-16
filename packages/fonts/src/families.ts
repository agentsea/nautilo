import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type NautiloFontRole =
  | "sans"
  | "serif"
  | "mono"
  | "cjkSans"
  | "arabic"
  | "emoji";

export const NAUTILO_FONT_FAMILIES = {
  sans: "Nautilo Noto Sans",
  serif: "Nautilo Noto Serif",
  mono: "Nautilo Noto Sans Mono",
  cjkSc: "Nautilo Noto Sans CJK SC",
  cjkTc: "Nautilo Noto Sans CJK TC",
  cjkJp: "Nautilo Noto Sans CJK JP",
  arabic: "Nautilo Noto Naskh Arabic",
  emoji: "Nautilo Noto Color Emoji",
} as const;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function asset(...parts: string[]): string {
  return join(root, "assets", ...parts);
}

export const NAUTILO_FONT_ASSETS = {
  sansRegular: asset("core", "sans", "NotoSans-Regular.ttf"),
  sansBold: asset("core", "sans", "NotoSans-Bold.ttf"),
  serifRegular: asset("core", "serif", "NotoSerif-Regular.ttf"),
  monoRegular: asset("core", "mono", "NotoSansMono-Regular.ttf"),
  cjkScRegular: asset("cjk", "sc", "NotoSansCJKsc-Regular.otf"),
  cjkTcRegular: asset("cjk", "tc", "NotoSansCJKtc-Regular.otf"),
  cjkJpRegular: asset("cjk", "jp", "NotoSansCJKjp-Regular.otf"),
  arabicRegular: asset("arabic", "NotoNaskhArabic-Regular.ttf"),
  emojiRegular: asset("emoji", "NotoColorEmoji.ttf"),
} as const;
