export interface SecretLeakFinding {
  readonly id: string;
  readonly label: string;
  readonly count: number;
}

interface LeakPattern {
  readonly id: string;
  readonly label: string;
  readonly pattern: RegExp;
}

const LEAK_PATTERNS: readonly LeakPattern[] = [
  { id: "openai_key", label: "OpenAI API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: "anthropic_key", label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "github_token", label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { id: "google_api_key", label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "slack_token", label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { id: "stripe_live_key", label: "Stripe live key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  { id: "aws_access_key_id", label: "AWS access key id", pattern: /\bA(?:KIA|SIA)[A-Z0-9]{16}\b/g },
  { id: "npm_token", label: "npm token", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  { id: "huggingface_token", label: "Hugging Face token", pattern: /\bhf_[A-Za-z0-9]{20,}\b/g },
  { id: "telegram_bot_token", label: "Telegram bot token", pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g },
  { id: "pem_block", label: "PEM private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { id: "authorization_header", label: "Authorization header", pattern: /\bAuthorization:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { id: "db_url", label: "database URL", pattern: /\b(?:postgres|postgresql|mysql|mongodb):\/\/[^\s:@]+:[^\s@]+@[^\s]+/gi },
  { id: "env_secret_assignment", label: "secret env assignment", pattern: /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)\s*=\s*['"]?[^'"\s]{8,}/g },
  { id: "json_secret_field", label: "secret JSON field", pattern: /"(?:token|secret|password|apiKey|api_key|privateKey|private_key)"\s*:\s*"[^"]{8,}"/gi },
];

export interface LeakScanResult {
  readonly text: string;
  readonly findings: readonly SecretLeakFinding[];
}

export function redactSecretLikeValues(text: string): LeakScanResult {
  let output = text;
  const findings: SecretLeakFinding[] = [];

  for (const leak of LEAK_PATTERNS) {
    let count = 0;
    output = output.replace(leak.pattern, () => {
      count += 1;
      return `[REDACTED ${leak.label}]`;
    });
    if (count > 0) {
      findings.push({ id: leak.id, label: leak.label, count });
    }
  }

  return { text: output, findings };
}

