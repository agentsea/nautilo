import { isCloudConvertConfigured } from "@nautilo/cloudconvert";

export type ConvertBackend = "local" | "cloud";
export type BackendPreference = ConvertBackend | "auto";

const LOCAL_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["md", "pdf"],
  ["md", "docx"],
];

export function normalizeFormat(format: string): string {
  return format.trim().toLowerCase().replace(/^\./, "");
}

function canConvertLocally(inputFormat: string, outputFormat: string): boolean {
  const input = normalizeFormat(inputFormat);
  const output = normalizeFormat(outputFormat);
  return LOCAL_PAIRS.some(([from, to]) => from === input && to === output);
}

function readEnvBackend(): BackendPreference | undefined {
  const raw = process.env["NAUTILO_CONVERT_BACKEND"]?.trim().toLowerCase();
  if (raw === "local" || raw === "cloud" || raw === "auto") {
    return raw;
  }
  return undefined;
}

export function resolveConvertBackend(args: {
  explicit?: BackendPreference | undefined;
  inputFormat: string;
  outputFormat: string;
  isCloudConfigured?: () => boolean;
}): { ok: true; backend: ConvertBackend } | { ok: false; error: string } {
  const cloudConfigured = args.isCloudConfigured ?? isCloudConvertConfigured;
  const preference: BackendPreference = args.explicit ?? readEnvBackend() ?? "local";
  const input = normalizeFormat(args.inputFormat);
  const output = normalizeFormat(args.outputFormat);

  if (preference === "local") {
    if (!canConvertLocally(input, output)) {
      return {
        ok: false,
        error:
          `Local backend cannot convert ${input} → ${output}. ` +
          `Local routes: Markdown → PDF/DOCX. Use backend="cloud" with CLOUDCONVERT_API_KEY for other pairs.`,
      };
    }
    return { ok: true, backend: "local" };
  }

  if (preference === "cloud") {
    if (!cloudConfigured()) {
      return {
        ok: false,
        error: "CloudConvert not configured (set CLOUDCONVERT_API_KEY)",
      };
    }
    return { ok: true, backend: "cloud" };
  }

  if (canConvertLocally(input, output)) {
    return { ok: true, backend: "local" };
  }
  if (cloudConfigured()) {
    return { ok: true, backend: "cloud" };
  }
  return {
    ok: false,
    error:
      `No backend can convert ${input} → ${output}. ` +
      `Configure CLOUDCONVERT_API_KEY for cloud conversion, or use a supported local pair (Markdown → PDF/DOCX).`,
  };
}
