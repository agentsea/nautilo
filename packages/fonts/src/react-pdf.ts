import {
  NAUTILO_FONT_ASSETS,
  NAUTILO_FONT_FAMILIES,
  type NautiloFontRole,
} from "./families";
import { hasArabic, hasCjk, hasEmoji } from "./detect-script";

interface ReactPdfFontRegistry {
  register: (font: never) => void;
}

let registered = false;

export function registerReactPdfFonts(Font: ReactPdfFontRegistry): void {
  if (registered) return;
  Font.register({
    family: NAUTILO_FONT_FAMILIES.sans,
    fonts: [
      { src: NAUTILO_FONT_ASSETS.sansRegular, fontWeight: "normal" },
      { src: NAUTILO_FONT_ASSETS.sansBold, fontWeight: "bold" },
    ],
  } as never);
  Font.register({
    family: NAUTILO_FONT_FAMILIES.serif,
    src: NAUTILO_FONT_ASSETS.serifRegular,
  } as never);
  Font.register({
    family: NAUTILO_FONT_FAMILIES.mono,
    src: NAUTILO_FONT_ASSETS.monoRegular,
  } as never);
  Font.register({
    family: NAUTILO_FONT_FAMILIES.cjkSc,
    src: NAUTILO_FONT_ASSETS.cjkScRegular,
  } as never);
  Font.register({
    family: NAUTILO_FONT_FAMILIES.cjkTc,
    src: NAUTILO_FONT_ASSETS.cjkTcRegular,
  } as never);
  Font.register({
    family: NAUTILO_FONT_FAMILIES.cjkJp,
    src: NAUTILO_FONT_ASSETS.cjkJpRegular,
  } as never);
  Font.register({
    family: NAUTILO_FONT_FAMILIES.arabic,
    src: NAUTILO_FONT_ASSETS.arabicRegular,
  } as never);
  // Noto Color Emoji is bundled but not registered until React-PDF color
  // emoji rendering is verified. Current policy is clear failure on emoji.
  registered = true;
}

export function reactPdfFamilyForRole(role: NautiloFontRole): string {
  switch (role) {
    case "serif":
      return NAUTILO_FONT_FAMILIES.serif;
    case "mono":
      return NAUTILO_FONT_FAMILIES.mono;
    case "cjkSans":
      return NAUTILO_FONT_FAMILIES.cjkSc;
    case "arabic":
      return NAUTILO_FONT_FAMILIES.arabic;
    case "emoji":
    case "sans":
    default:
      return NAUTILO_FONT_FAMILIES.sans;
  }
}

export function reactPdfFamilyForText(text: string, fallbackRole: NautiloFontRole = "sans"): string {
  if (hasArabic(text)) return NAUTILO_FONT_FAMILIES.arabic;
  if (hasCjk(text)) return NAUTILO_FONT_FAMILIES.cjkSc;
  return reactPdfFamilyForRole(fallbackRole);
}

export function validateTextForReactPdfFonts(text: string): string | null {
  if (!hasEmoji(text)) return null;
  return (
    "Text contains emoji. Nautilo bundles an emoji font, but React-PDF color emoji rendering is not verified yet. " +
    "Remove emoji or replace them with text equivalents until the D104 emoji rendering pass lands."
  );
}
