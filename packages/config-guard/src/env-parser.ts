export type EnvEntry =
  | { type: "comment"; raw: string }
  | { type: "blank" }
  | { type: "pair"; key: string; value: string; raw: string };

const PAIR_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function unquoteValue(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2) {
    if (t.startsWith('"') && t.endsWith('"')) {
      return t
        .slice(1, -1)
        .replaceAll("\\n", "\n")
        .replaceAll('\\"', '"')
        .replaceAll("\\\\", "\\");
    }
    if (t.startsWith("'") && t.endsWith("'")) {
      return t.slice(1, -1).replaceAll("\\'", "'");
    }
  }
  return t;
}

function escapeForEnv(value: string): string {
  if (/[\s#"'\n\\]/.test(value)) {
    const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
    return `"${escaped}"`;
  }
  return value;
}

export function parseEnvFile(content: string): EnvEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: EnvEntry[] = [];
  for (const line of lines) {
    if (line === "") {
      entries.push({ type: "blank" });
      continue;
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) {
      entries.push({ type: "comment", raw: line });
      continue;
    }
    const m = line.match(PAIR_RE);
    if (m?.[1] && m[2] !== undefined) {
      const key = m[1];
      const value = unquoteValue(m[2]);
      entries.push({ type: "pair", key, value, raw: line });
      continue;
    }
    entries.push({ type: "comment", raw: line });
  }
  return entries;
}

export function serializeEnvFile(entries: EnvEntry[]): string {
  const out: string[] = [];
  for (const e of entries) {
    if (e.type === "blank") {
      out.push("");
    } else if (e.type === "comment") {
      out.push(e.raw);
    } else {
      out.push(`${e.key}=${escapeForEnv(e.value)}`);
    }
  }
  return out.join("\n") + (out.length > 0 ? "\n" : "");
}

export function getValueFromEntries(entries: EnvEntry[], key: string): string | undefined {
  let last: string | undefined;
  for (const e of entries) {
    if (e.type === "pair" && e.key === key) {
      last = e.value;
    }
  }
  return last;
}

export function setValueInEntries(entries: EnvEntry[], key: string, value: string): EnvEntry[] {
  const next = [...entries];
  let idx = -1;
  for (let i = next.length - 1; i >= 0; i--) {
    const e = next[i];
    if (e?.type === "pair" && e.key === key) {
      idx = i;
      break;
    }
  }
  const raw = `${key}=${escapeForEnv(value)}`;
  if (idx >= 0) {
    next[idx] = { type: "pair", key, value, raw };
  } else {
    if (next.length > 0 && next[next.length - 1]?.type !== "blank") {
      next.push({ type: "blank" });
    }
    next.push({ type: "pair", key, value, raw });
  }
  return next;
}

export function removeKeyFromEntries(entries: EnvEntry[], key: string): EnvEntry[] {
  return entries.filter((e) => !(e.type === "pair" && e.key === key));
}
