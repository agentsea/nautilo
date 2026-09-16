/**
 * Shell command scanner — normalizes commands and checks against dangerous patterns.
 *
 * Ported from Hermes tools/approval.py DANGEROUS_PATTERNS with additions
 * for Nautilo's tool approval boundary.
 */

import { resolveSecurityLayers, type SecurityLevel } from "./security-config";
import { debug, warn } from "@nautilo/logger";

// ---------------------------------------------------------------------------
// Normalization (port of Hermes _normalize_command_for_detection)
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- intentional: stripping ANSI escape sequences
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function normalizeCommandForDetection(command: string): string {
  return command
    .replace(ANSI_REGEX, "")
    .replaceAll("\0", "")
    .normalize("NFKC")
    .toLowerCase()
    .trim();
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

export type CommandPattern = {
  pattern: RegExp;
  key: string;
  severity: "critical" | "high" | "medium";
  description: string;
};

export const DANGEROUS_PATTERNS: CommandPattern[] = [
  // === Critical: always blocked, no approval possible ===

  // Recursive deletion
  { pattern: /rm\s+(-[a-z]*r[a-z]*f|--recursive)\s+\//, key: "rm_rf_root", severity: "critical", description: "Recursive deletion from root" },
  { pattern: /rm\s+-[a-z]*f[a-z]*r\s+\//, key: "rm_fr_root", severity: "critical", description: "Recursive deletion from root (flag order variant)" },
  { pattern: /find\s+\/\s+.*-delete/, key: "find_delete_root", severity: "critical", description: "find / -delete" },
  { pattern: /find\s+\/\s+.*-exec\s+rm/, key: "find_exec_rm_root", severity: "critical", description: "find / -exec rm" },

  // Disk destruction
  { pattern: /mkfs\./, key: "mkfs", severity: "critical", description: "Disk formatting" },
  { pattern: /dd\s+if=\/dev\/(zero|random|urandom)\s+of=\/dev\/[sh]d/, key: "dd_overwrite_disk", severity: "critical", description: "Disk overwrite via dd" },
  { pattern: /wipefs/, key: "wipefs", severity: "critical", description: "Filesystem signature wipe" },

  // Fork bomb
  { pattern: /:\(\)\s*\{.*\|.*&.*\}\s*;/, key: "fork_bomb", severity: "critical", description: "Fork bomb" },

  // Critical obfuscation — base64/reverse piped to shell
  { pattern: /\|\s*base64\s+(-d|--decode)\s*\|\s*(ba)?sh/, key: "base64_to_shell", severity: "critical", description: "Base64 decoded and piped to shell" },
  { pattern: /\|\s*rev\s*\|\s*(ba)?sh/, key: "rev_pipe_shell", severity: "critical", description: "String reversal piped to shell" },

  // === High: blocked, may be approvable in Phase 3 ===

  // Privilege escalation
  { pattern: /\bsudo\s/, key: "sudo", severity: "high", description: "Privilege escalation via sudo" },
  { pattern: /\bsu\s+-/, key: "su_switch", severity: "high", description: "User switch via su" },
  { pattern: /\bdoas\s/, key: "doas", severity: "high", description: "Privilege escalation via doas" },
  { pattern: /\bpkexec\s/, key: "pkexec", severity: "high", description: "Privilege escalation via pkexec" },

  // Permission changes
  { pattern: /chmod\s+777/, key: "chmod_777", severity: "high", description: "World-writable permissions" },
  { pattern: /chmod\s+[0-7]*[2367][0-7]*\s/, key: "chmod_world_write", severity: "high", description: "Permissions allowing world-write" },
  { pattern: /chown\s+root/, key: "chown_root", severity: "high", description: "Changing ownership to root" },

  // Credential exfiltration
  { pattern: /cat\s+~?\/?\.ssh\//, key: "read_ssh", severity: "high", description: "Reading SSH keys" },
  { pattern: /cat\s+~?\/?\.gnupg\//, key: "read_gpg", severity: "high", description: "Reading GPG keys" },
  { pattern: /cat\s+\/etc\/(passwd|shadow)/, key: "read_etc_creds", severity: "high", description: "Reading system credential files" },
  // D418 A2 — public templates whose basename ends with `.example`,
  // `.sample`, `.template`, or `.dist` (including `.env.local-smoke.example`)
  // are read-only in Seatbelt. Keep the scanner aligned, but inspect ONLY the
  // immediate `cat` operand: a later template in `cat secret.pem && cat
  // README.example` must never suppress the first secret read. The operand
  // forms below cover unquoted, single-quoted, and double-quoted paths.
  // Live variants (`.env`, `.env.local`, `.env.production`) and non-terminal
  // shapes like `.env.example.local` still flag. Never exempt arbitrary
  // `.env*`.
  {
    pattern:
      /cat\s+(?!(?:"[^"]*|'[^']*'|[^\s;&|]*)\.(?:example|sample|template|dist)(?:"|'|(?=\s|$|;|&|\|)))(?:"[^"]*\.(?:env|pem|key|crt|p12|pfx|jks)\b[^"]*"|'[^']*\.(?:env|pem|key|crt|p12|pfx|jks)\b[^']*'|[^\s;&|]*\.(?:env|pem|key|crt|p12|pfx|jks)\b)/,
    key: "read_secrets",
    severity: "high",
    description: "Reading secret/key files",
  },
  { pattern: /env\s*\|.*curl/, key: "env_exfil_curl", severity: "high", description: "Environment exfiltration via curl" },
  { pattern: /env\s*\|.*wget/, key: "env_exfil_wget", severity: "high", description: "Environment exfiltration via wget" },
  { pattern: /curl\s+.*\|\s*(ba)?sh/, key: "curl_pipe_shell", severity: "high", description: "curl piped to shell" },
  { pattern: /wget\s+.*-O\s*-\s*\|\s*(ba)?sh/, key: "wget_pipe_shell", severity: "high", description: "wget piped to shell" },

  // Env var credential access (credential-boundary finding — prev pattern only
  // caught piped env exfil). Plain `echo $API_KEY`, `env`, `printenv`
  // surface secrets to the agent context even without a network hop.
  {
    pattern: /\becho\s+["']?\$\{?[a-z_]*(key|token|secret|password|credential|auth|private|apikey)/,
    key: "echo_secret_var",
    severity: "high",
    description: "Echoing a suspected credential environment variable",
  },
  {
    pattern: /\b(env|printenv)(\s|$|;|&|\|)/,
    key: "env_dump",
    severity: "high",
    description: "Dumping environment variables (env/printenv)",
  },
  {
    pattern: /cat\s+~?\/?\.(zshrc|bashrc|bash_profile|bash_login|profile|zshenv|zprofile)\b/,
    key: "read_shell_init",
    severity: "high",
    description: "Reading shell init file (likely contains exported secrets)",
  },

  // System file modification
  { pattern: />\s*\/etc\//, key: "write_etc", severity: "high", description: "Writing to /etc/" },
  { pattern: /tee\s+\/etc\//, key: "tee_etc", severity: "high", description: "Tee to /etc/" },
  { pattern: /echo\s.*>\s*\/etc\//, key: "echo_etc", severity: "high", description: "Echo redirect to /etc/" },
  { pattern: /crontab\s+-[re]/, key: "crontab_edit", severity: "high", description: "Editing crontab" },
  { pattern: />\s*~?\/?\.bashrc/, key: "write_bashrc", severity: "high", description: "Writing to .bashrc" },
  { pattern: />\s*~?\/?\.bash_profile/, key: "write_bash_profile", severity: "high", description: "Writing to .bash_profile" },
  { pattern: />\s*~?\/?\.zshrc/, key: "write_zshrc", severity: "high", description: "Writing to .zshrc" },
  { pattern: />\s*~?\/?\.profile/, key: "write_profile", severity: "high", description: "Writing to .profile" },

  // Network exfiltration
  { pattern: /\bnc\s+-[a-z]*l/, key: "netcat_listen", severity: "high", description: "Netcat listener (reverse shell)" },
  { pattern: /\bncat\s/, key: "ncat", severity: "high", description: "Ncat usage" },
  { pattern: /\bsocat\s/, key: "socat", severity: "high", description: "Socat usage" },
  { pattern: /\/dev\/tcp\//, key: "dev_tcp", severity: "high", description: "Bash /dev/tcp (network without tools)" },

  // Git destructive
  { pattern: /git\s+push\s+.*--force(?!-with-lease)/, key: "git_force_push", severity: "high", description: "Git force push (not force-with-lease)" },
  { pattern: /git\s+reset\s+--hard/, key: "git_reset_hard", severity: "high", description: "Git hard reset" },
  { pattern: /git\s+clean\s+-[a-z]*f/, key: "git_clean_force", severity: "high", description: "Git clean force" },

  // Obfuscation — high severity
  { pattern: /echo\s+[A-Za-z0-9+/=]{10,}\s*\|\s*base64\s+(-d|--decode)/, key: "base64_decode_pipe", severity: "high", description: "Base64 decode piped to execution" },
  { pattern: /eval\s+["$(]/, key: "eval_exec", severity: "high", description: "Eval wrapper with dynamic content" },
  { pattern: /\$'\\x[0-9a-fA-F]{2}/, key: "ansi_c_escape", severity: "high", description: "ANSI-C quoting hex escape" },
  { pattern: /python[23]?\s+-c\s+.*chr\s*\(/, key: "python_chr", severity: "high", description: "Python chr() character building" },
  { pattern: /perl\s+-e\s+.*chr\s*\(/, key: "perl_chr", severity: "high", description: "Perl chr() character building" },
  { pattern: /printf\s+.*\\x[0-9a-fA-F]/, key: "printf_hex", severity: "high", description: "Printf hex escape sequence" },

  // === Medium: flagged, context-dependent ===

  // Nested shells
  { pattern: /bash\s+-c\s+["']/, key: "bash_c", severity: "medium", description: "bash -c with inline command" },
  { pattern: /sh\s+-c\s+["']/, key: "sh_c", severity: "medium", description: "sh -c with inline command" },
  { pattern: /zsh\s+-c\s+["']/, key: "zsh_c", severity: "medium", description: "zsh -c with inline command" },

  // Process manipulation
  { pattern: /kill\s+-9\s+1\b/, key: "kill_init", severity: "medium", description: "Killing init process" },
  { pattern: /killall\s/, key: "killall", severity: "medium", description: "Killing processes by name" },
  { pattern: /pkill\s/, key: "pkill", severity: "medium", description: "Killing processes by pattern" },

  // Package manager abuse
  { pattern: /npm\s+install\s+-g\s/, key: "npm_global_install", severity: "medium", description: "Global npm install" },
  { pattern: /pip\s+install\s+(?!-r\s)(?!--requirement)/, key: "pip_install", severity: "medium", description: "pip install without requirements file" },

  // Package-specifier installs (credential-boundary finding — prev only matched
  // -g). Plain `npm install foo` runs arbitrary postinstall scripts from
  // the registry. `npm install` alone (no package name) installs from
  // the vetted package.json, so we allow that; only flag when a package
  // specifier follows. Same for yarn/pnpm/bun add and pip install pkg.
  {
    pattern: /\bnpm\s+install\s+(?:--?[a-zA-Z-]+\s+)*[a-z@]/,
    key: "npm_install_pkg",
    severity: "medium",
    description: "npm install <package> (supply-chain risk via postinstall scripts)",
  },
  {
    pattern: /\byarn\s+add\s+(?:--?[a-zA-Z-]+\s+)*[a-z@]/,
    key: "yarn_add_pkg",
    severity: "medium",
    description: "yarn add <package>",
  },
  {
    pattern: /\bpnpm\s+(?:add|install)\s+(?:--?[a-zA-Z-]+\s+)*[a-z@]/,
    key: "pnpm_add_pkg",
    severity: "medium",
    description: "pnpm add/install <package>",
  },
  {
    pattern: /\bbun\s+add\s+(?:--?[a-zA-Z-]+\s+)*[a-z@]/,
    key: "bun_add_pkg",
    severity: "medium",
    description: "bun add <package>",
  },

  // SQL injection
  { pattern: /drop\s+(table|database|index)/, key: "sql_drop", severity: "medium", description: "SQL DROP statement" },
  { pattern: /delete\s+from\s+\w+\s*(?:;|$)/, key: "sql_delete_no_where", severity: "medium", description: "SQL DELETE without WHERE" },
  { pattern: /truncate\s+table/, key: "sql_truncate", severity: "medium", description: "SQL TRUNCATE TABLE" },

  // Service control
  { pattern: /systemctl\s+(stop|disable|mask)\s/, key: "systemctl_stop", severity: "medium", description: "Stopping/disabling system service" },
  { pattern: /service\s+\w+\s+stop/, key: "service_stop", severity: "medium", description: "Stopping service" },
  { pattern: /launchctl\s+(unload|remove)\s/, key: "launchctl_unload", severity: "medium", description: "Unloading macOS launch agent" },

  // Swap/memory
  { pattern: /swapon\s/, key: "swapon", severity: "medium", description: "Enabling swap" },
  { pattern: /swapoff\s/, key: "swapoff", severity: "medium", description: "Disabling swap" },

  // Kernel
  { pattern: /\binsmod\s/, key: "insmod", severity: "medium", description: "Loading kernel module" },
  { pattern: /\brmmod\s/, key: "rmmod", severity: "medium", description: "Removing kernel module" },
  { pattern: /\bmodprobe\s/, key: "modprobe", severity: "medium", description: "Modprobe" },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type CommandScanResult = {
  allowed: boolean;
  severity?: "critical" | "high" | "medium";
  matchedPatterns: Array<{ key: string; description: string; severity: string }>;
  normalizedCommand: string;
};

export function scanCommand(command: string, level: SecurityLevel): CommandScanResult {
  const layers = resolveSecurityLayers(level);
  const normalized = normalizeCommandForDetection(command);

  if (!layers.commandScanning) {
    debug(`[security] Command scanning disabled (level=${level})`);
    return { allowed: true, matchedPatterns: [], normalizedCommand: normalized };
  }

  const matches: CommandPattern[] = [];
  for (const p of DANGEROUS_PATTERNS) {
    if (p.pattern.test(normalized)) {
      matches.push(p);
    }
  }

  if (matches.length === 0) {
    return { allowed: true, matchedPatterns: [], normalizedCommand: normalized };
  }

  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2 };
  matches.sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));
  const worst = matches[0]!;

  warn(
    `[security] Command BLOCKED (${worst.severity}): ${matches.map((m) => m.key).join(", ")} — "${normalized.slice(0, 80)}"`,
  );

  return {
    allowed: false,
    severity: worst.severity,
    matchedPatterns: matches.map((m) => ({ key: m.key, description: m.description, severity: m.severity })),
    normalizedCommand: normalized,
  };
}
