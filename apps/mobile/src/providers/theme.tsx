// D381 — AppThemeProvider: follows the OS light/dark setting and exposes the
// resolved Nautilo theme (shared brand colors + mobile scale) via useAppTheme.
// D383 Stage 1a — adds a persisted manual override (System/Light/Dark) via
// useThemePreference. The override lives in AsyncStorage and re-resolves the
// theme; `useAppTheme` keeps its existing shape so current callers are
// unaffected.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { type NautiloThemeMode } from "@nautilo/config/design-tokens";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";

import { buildAppTheme, type AppTheme } from "@/theme/tokens";

/** Manual override on top of the OS color scheme. `system` follows the OS. */
export type ThemePreference = "system" | NautiloThemeMode;

const THEME_STORAGE_KEY = "nautilo.theme.preference";

const ThemeContext = createContext<AppTheme | null>(null);

interface ThemePreferenceValue {
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
}

const ThemePreferenceContext = createContext<ThemePreferenceValue | null>(null);

const VALID_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

function isThemePreference(v: unknown): v is ThemePreference {
  return typeof v === "string" && (VALID_PREFERENCES as readonly string[]).includes(v);
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>("system");

  // Load the persisted override once on mount. Until the async read resolves,
  // we behave as "system" (the pre-override default), so first paint matches
  // the OS as before.
  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(THEME_STORAGE_KEY)
      .then((raw) => {
        if (!active || raw == null) return;
        if (isThemePreference(raw)) setPreferenceState(raw);
      })
      .catch(() => {
        // Storage read failed — keep "system" default. No surfacing needed;
        // the override is a cosmetic preference and degrades safely.
      });
    return () => {
      active = false;
    };
  }, []);

  const setPreference = (p: ThemePreference) => {
    setPreferenceState(p);
    AsyncStorage.setItem(THEME_STORAGE_KEY, p).catch(() => {
      // Persistence failed — in-memory state still updates for this session.
    });
  };

  const effectiveMode: NautiloThemeMode =
    preference === "system" ? (scheme === "dark" ? "dark" : "light") : preference;

  const theme = useMemo(() => buildAppTheme(effectiveMode), [effectiveMode]);

  const preferenceValue = useMemo<ThemePreferenceValue>(
    () => ({ preference, setPreference }),
    [preference],
  );

  return (
    <ThemePreferenceContext.Provider value={preferenceValue}>
      <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
    </ThemePreferenceContext.Provider>
  );
}

export function useAppTheme(): AppTheme {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useAppTheme must be used within AppThemeProvider");
  return ctx;
}

export function useThemePreference(): ThemePreferenceValue {
  const ctx = useContext(ThemePreferenceContext);
  if (!ctx) throw new Error("useThemePreference must be used within AppThemeProvider");
  return ctx;
}
