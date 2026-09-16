/**
 * Content scanner — detects prompt injection and invisible Unicode in
 * untrusted content (tool results, MCP results, file contents).
 *
 * Ported from:
 * - Hermes agent/prompt_builder.py _CONTEXT_THREAT_PATTERNS (prompt injection)
 * - Hermes tools/skills_guard.py INVISIBLE_CHARS (18-char set)
 *
 * Matches Hermes _scan_context_content() behavior: if ANY pattern matches,
 * the entire content is replaced. No partial redaction — untrusted content
 * is all-or-nothing.
 */

import { warn } from "@nautilo/logger";
import { redactSecrets } from "@nautilo/vault";
import { resolveSecurityLayers, type SecurityLevel } from "./security-config";

// ---------------------------------------------------------------------------
// Prompt injection patterns
// ---------------------------------------------------------------------------

type ThreatPattern = { pattern: RegExp; id: string };

const THREAT_PATTERNS: ThreatPattern[] = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: "prompt_injection" },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: "deception_hide" },
  { pattern: /system\s+prompt\s+override/i, id: "sys_prompt_override" },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: "disregard_rules" },
  { pattern: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have|do\s+not\s+have)\s+(restrictions|limits|rules)/i, id: "bypass_restrictions" },
  { pattern: /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i, id: "html_comment_injection" },
  { pattern: /<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i, id: "hidden_div" },
  { pattern: /translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i, id: "translate_execute" },
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_curl" },
  // Inspect only the immediate `cat` operand. Tool output such as a one-line
  // JSON array can contain an unrelated word ending in "cat" and a later PR
  // title mentioning "credentials"; allowing the match to span that entire
  // line falsely blocks otherwise safe output.
  {
    pattern:
      /\bcat\s+(?:"[^"]*(?:\.env|credentials|\.netrc|\.pgpass)[^"]*"|'[^']*(?:\.env|credentials|\.netrc|\.pgpass)[^']*'|[^\s;&|]*(?:\.env|credentials|\.netrc|\.pgpass)[^\s;&|]*)/i,
    id: "read_secrets",
  },
  // Instruction delimiter injection (Anthropic, OpenAI, LLaMA formats)
  { pattern: /<\|im_start\|>\s*system/i, id: "chatml_system_inject" },
  { pattern: /<\|system\|>/i, id: "system_tag_inject" },
  { pattern: /\[INST\][\s\S]*?system:/i, id: "llama_system_inject" },
  { pattern: /<\/user>\s*<assistant>/i, id: "role_confusion" },
];

// ---------------------------------------------------------------------------
// Invisible Unicode detection (18-char set from Hermes skills_guard.py)
// ---------------------------------------------------------------------------

const INVISIBLE_CHARS = new Set([
  "\u200b",  // zero-width space
  "\u200c",  // zero-width non-joiner
  "\u200d",  // zero-width joiner
  "\u2060",  // word joiner
  "\u2062",  // invisible times
  "\u2063",  // invisible separator
  "\u2064",  // invisible plus
  "\ufeff",  // zero-width no-break space (BOM)
  "\u202a",  // left-to-right embedding
  "\u202b",  // right-to-left embedding
  "\u202c",  // pop directional formatting
  "\u202d",  // left-to-right override
  "\u202e",  // right-to-left override
  "\u2066",  // left-to-right isolate
  "\u2067",  // right-to-left isolate
  "\u2068",  // first strong isolate
  "\u2069",  // pop directional isolate
]);

function detectInvisibleUnicode(content: string): string[] {
  const found = new Set<string>();
  for (const char of content) {
    if (INVISIBLE_CHARS.has(char)) {
      const hex = char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
      found.add(`invisible_unicode_U+${hex}`);
    }
  }
  return [...found];
}

/**
 * Remove invisible/zero-width/bidi-control characters from text.
 *
 * For sources where invisible Unicode is legitimately ubiquitous and benign —
 * e.g. live web-page accessibility snapshots (Google Docs is full of U+200B) —
 * blocking the whole payload makes the tool useless. Stripping the invisible
 * characters neutralizes the smuggled-instruction risk (a hidden instruction
 * cannot survive removal of the characters that hid it) while preserving the
 * visible content. The prompt-injection TEXT patterns still apply to the
 * stripped content, so genuine injection is still caught.
 *
 * Iterates by code point against the same `INVISIBLE_CHARS` set used for
 * detection (no regex character class — those chars trip
 * `no-misleading-character-class`).
 */
export function stripInvisibleUnicode(text: string): { text: string; stripped: number } {
  let stripped = 0;
  let out = "";
  for (const char of text) {
    if (INVISIBLE_CHARS.has(char)) {
      stripped += 1;
      continue;
    }
    out += char;
  }
  return { text: out, stripped };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ContentScanResult = {
  safe: boolean;
  threats: string[];
  replacement?: string;
};

/**
 * Human-safe result for content blocked at the untrusted-content boundary.
 *
 * Threat identifiers are intentionally excluded: they are useful only in
 * server-side warnings/audit telemetry and must not become prompt-visible or
 * client-rendered content.
 */
export const BLOCKED_CONTENT_USER_MESSAGE =
  "Nautilo blocked this tool result because it may contain unsafe instructions. Content was not loaded.";

/**
 * Scan content for prompt injection and invisible Unicode.
 *
 * If ANY threat is detected, the entire content should be replaced with
 * the `replacement` string. No partial redaction.
 *
 * @param content - The untrusted content to scan
 * @param source - A label for the source (e.g. "webpage", "web_search", MCP tool name)
 */
export function scanContent(content: string, source: string): ContentScanResult {
  const threats: string[] = [];

  for (const { pattern, id } of THREAT_PATTERNS) {
    if (pattern.test(content)) {
      threats.push(id);
    }
  }

  threats.push(...detectInvisibleUnicode(content));

  if (threats.length === 0) {
    return { safe: true, threats: [] };
  }

  warn(
    `[security] Content BLOCKED from ${source}: ${threats.join(", ")}`,
  );

  return {
    safe: false,
    threats,
    replacement: BLOCKED_CONTENT_USER_MESSAGE,
  };
}

// ---------------------------------------------------------------------------
// Middleware — consumes resultScanPolicy from catalog entries
// ---------------------------------------------------------------------------

export type ResultScanPolicy = "always" | "on-suspicious" | "never";

export type ScanResult = {
  content: string;
  scanned: boolean;
  blocked: boolean;
  threats: string[];
  secretRedactions?: number;
};

/**
 * Apply content scanning to a tool result based on the catalog's
 * resultScanPolicy. Returns possibly-replaced content.
 *
 * Called by toolsNode after tool.invoke() returns, before the result
 * goes into a ToolMessage.
 */
export function scanToolResult(
  toolName: string,
  result: string,
  options: {
    scanPolicy: ResultScanPolicy;
    securityLevel: SecurityLevel;
    source?: string;
    /**
     * When true, strip invisible/zero-width/bidi-control characters from the
     * result instead of blocking on them. Prompt-injection text patterns still
     * apply to the stripped content. Used for tools whose results are live web
     * content (e.g. browser_* embedded-app tools) where invisible Unicode is
     * benign and ubiquitous; blocking would make the tool unusable.
     */
    stripInvisibleUnicode?: boolean;
  },
): ScanResult {
  const { scanPolicy, securityLevel, source, stripInvisibleUnicode: strip } = options;
  const redacted = redactSecrets(result);
  const secretThreats = [
    ...(redacted.exactRedactions > 0 ? ["connection_exact_redacted"] : []),
    ...redacted.leakFindings.map((finding) => `secret_like_${finding.id}`),
  ];
  const safeResult = strip ? stripInvisibleUnicode(redacted.text).text : redacted.text;
  const secretRedactionCount =
    redacted.exactRedactions +
    redacted.leakFindings.reduce((sum, finding) => sum + finding.count, 0);

  const layers = resolveSecurityLayers(securityLevel);

  if (scanPolicy === "never" || !layers.contentScanning) {
    return {
      content: safeResult,
      scanned: secretThreats.length > 0,
      blocked: false,
      threats: secretThreats,
      secretRedactions: secretRedactionCount,
    };
  }

  const scan = scanContent(safeResult, source ?? toolName);
  if (!scan.safe && scan.replacement) {
    return {
      content: scan.replacement,
      scanned: true,
      blocked: true,
      threats: [...secretThreats, ...scan.threats],
      secretRedactions: secretRedactionCount,
    };
  }

  return {
    content: safeResult,
    scanned: true,
    blocked: false,
    threats: secretThreats,
    secretRedactions: secretRedactionCount,
  };
}
