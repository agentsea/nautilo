import { useEffect } from "react";
import { desktopAPI } from "../lib/desktop";
import { useToast } from "../components/toast";

/**
 * D368 Wave 2 — surface embedded-browser download completions as workbench
 * toasts. Downloads are auto-saved to the OS Downloads dir by the main
 * process; this hook just reports the outcome. App-level (mounted once in the
 * shell) so a toast still fires if the browser surface unmounts mid-download.
 * No-op in the browser / when the desktop bridge lacks `onDownload`.
 */
export function useBrowserDownloadToasts(): void {
  const toast = useToast();
  useEffect(() => {
    const onDownload = desktopAPI?.browserControl?.onDownload;
    if (!onDownload) return;
    return onDownload((evt) => {
      if (evt.state === "completed") {
        toast.show({
          variant: "success",
          title: "Download complete",
          message: evt.filename,
        });
      } else {
        toast.show({
          variant: "warning",
          title: `Download ${evt.state}`,
          message: evt.filename,
        });
      }
    });
  }, [toast]);
}
