import { useState, useEffect } from "react";

type Theme = "light" | "dark";

export function resolveInitialTheme(storage: Pick<Storage, "getItem"> | null): Theme {
  try {
    const stored = storage?.getItem("nautilo-theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage can throw in private/restricted contexts; fall back below.
  }
  return "dark";
}

function getInitialTheme(): Theme {
  return resolveInitialTheme(
    typeof window === "undefined" ? null : window.localStorage,
  );
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("nautilo-theme", theme);
  }, [theme]);

  return { theme, setTheme } as const;
}
