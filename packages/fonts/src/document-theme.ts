import type { NautiloFontRole } from "./families";

export interface DocumentTheme {
  name: "modern-report" | "classic-report" | "technical-note";
  fonts: {
    body: NautiloFontRole;
    heading: NautiloFontRole;
    mono: NautiloFontRole;
    fallback: NautiloFontRole[];
  };
  typography: {
    bodySize: number;
    headingScale: number;
    lineHeight: number;
  };
  colors: {
    foreground: string;
    muted: string;
    accent: string;
  };
}

export const modernReportTheme: DocumentTheme = {
  name: "modern-report",
  fonts: {
    body: "sans",
    heading: "sans",
    mono: "mono",
    fallback: ["cjkSans", "arabic"],
  },
  typography: {
    bodySize: 11,
    headingScale: 1.45,
    lineHeight: 1.45,
  },
  colors: {
    foreground: "#111827",
    muted: "#4b5563",
    accent: "#2563eb",
  },
};

export const classicReportTheme: DocumentTheme = {
  ...modernReportTheme,
  name: "classic-report",
  fonts: {
    body: "serif",
    heading: "sans",
    mono: "mono",
    fallback: ["cjkSans", "arabic"],
  },
};

export const technicalNoteTheme: DocumentTheme = {
  ...modernReportTheme,
  name: "technical-note",
  fonts: {
    body: "sans",
    heading: "sans",
    mono: "mono",
    fallback: ["cjkSans", "arabic"],
  },
};
