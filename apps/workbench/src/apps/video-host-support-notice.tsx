export function VideoHostSupportNotice({
  serverUrl,
  isDesktopShell,
  supportsWorkspaceMedia,
}: {
  serverUrl: string | null;
  isDesktopShell: boolean;
  supportsWorkspaceMedia: boolean;
}) {
  if (supportsWorkspaceMedia) return null;

  return (
    <aside
      className="shrink-0 border-b border-amber-600/40 bg-amber-500/10 px-4 py-3 text-xs leading-5 text-foreground"
      data-testid="video-host-support-notice"
      role="status"
    >
      <p className="font-medium">
        {isDesktopShell ? "Update Nautilo Desktop to use Video media." : "Video media needs Nautilo Desktop."}
      </p>
      <p className="mt-1 text-foreground-muted">
        You can edit and save this project here. Adding references, previewing generated output,
        adding completed clips to the Media Bin, and starting paid generation require a supported Desktop.
      </p>
      <p className="mt-1 text-foreground-muted">
        <a className="font-medium text-primary underline" href="https://nautilo.ai/download" target="_blank" rel="noopener noreferrer">
          Get Nautilo Desktop
        </a>
        {serverUrl ? (
          <> and connect with Server URL <code className="select-all text-foreground" data-testid="video-host-server-url">{serverUrl}</code>.</>
        ) : (
          <> and connect it to this server.</>
        )}
      </p>
    </aside>
  );
}
