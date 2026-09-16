import { PUBLIC_PRODUCT_LINKS } from "@nautilo/types";
import { useEffect, useState } from "react";
import { desktopAPI, isDesktop } from "../../../lib/desktop";
import { FieldRow, SectionCard } from "../ui";

const REPO_URL = "https://github.com/agentsea/nautilo";

export function AboutSection() {
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktop || !desktopAPI?.getVersion) return;
    let mounted = true;
    void desktopAPI.getVersion()
      .then((version) => {
        if (mounted) setDesktopVersion(version);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <SectionCard
      id="about"
      title="About"
      description="Build info and links."
    >
      <FieldRow label="Version">
        <div className="text-sm text-foreground">
          <div>
            Nautilo{desktopVersion ? ` ${desktopVersion}` : ""}
            {isDesktop && desktopAPI?.platform ? (
              <span className="ml-2 text-xs text-foreground-muted">
                ({desktopAPI.platform})
              </span>
            ) : !isDesktop ? (
              <span className="ml-2 text-xs text-foreground-muted">(web)</span>
            ) : null}
          </div>
          {isDesktop && desktopAPI?.electronVersion ? (
            <div className="mt-0.5 text-xs text-foreground-muted">
              Electron {desktopAPI.electronVersion}
            </div>
          ) : null}
        </div>
      </FieldRow>

      <FieldRow label="Privacy">
        <a
          href={PUBLIC_PRODUCT_LINKS.privacyPolicyUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-primary underline hover:text-primary-hover"
        >
          Privacy Policy
        </a>
      </FieldRow>

      <FieldRow label="Support">
        <a
          href={PUBLIC_PRODUCT_LINKS.supportContactUrl}
          className="text-sm text-primary underline hover:text-primary-hover"
        >
          support@kentauros.ai
        </a>
      </FieldRow>

      <FieldRow label="Source">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-primary underline hover:text-primary-hover"
        >
          {REPO_URL}
        </a>
      </FieldRow>

      <FieldRow label="Report an issue">
        <a
          href={`${REPO_URL}/issues/new`}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-primary underline hover:text-primary-hover"
        >
          Open GitHub issues
        </a>
      </FieldRow>
    </SectionCard>
  );
}
