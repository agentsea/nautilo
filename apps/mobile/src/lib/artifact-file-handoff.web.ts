import type { ArtifactFileHandoffOptions } from "./artifact-file-handoff";

interface BrowserAnchor {
  href: string;
  target: string;
  rel: string;
  click(): void;
  remove(): void;
}

export interface BrowserArtifactFileHandoffEnvironment {
  createAnchor(): BrowserAnchor;
  append(anchor: BrowserAnchor): void;
}

export function createBrowserArtifactFileHandoff(
  environment: BrowserArtifactFileHandoffEnvironment | null,
) {
  return {
    isAvailable(fileUri: string): boolean {
      return environment !== null && fileUri.startsWith("blob:");
    },
    open(fileUri: string, _options: ArtifactFileHandoffOptions): void {
      if (!environment || !fileUri.startsWith("blob:")) {
        throw new Error("Browser artifact file handoff is unavailable.");
      }
      const anchor = environment.createAnchor();
      anchor.href = fileUri;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      environment.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
    },
  };
}

const browserHandoff = createBrowserArtifactFileHandoff(
  typeof document === "undefined" || !document.body
    ? null
    : {
        createAnchor: () => document.createElement("a"),
        append: (anchor) => document.body.append(anchor as HTMLAnchorElement),
      },
);

export function isArtifactFileHandoffAvailable(fileUri: string): Promise<boolean> {
  return Promise.resolve(browserHandoff.isAvailable(fileUri));
}

export function openArtifactFile(
  fileUri: string,
  options: ArtifactFileHandoffOptions,
): Promise<void> {
  browserHandoff.open(fileUri, options);
  return Promise.resolve();
}
