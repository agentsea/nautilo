import { useEffect, useRef } from "react";
import { installStateBridge } from "./state-bridge";

export interface SandboxedHtmlIframeProps {
  srcDoc: string;
  /** D121-P3 — when provided, mounts the parent-side postMessage
   *  state bridge bound to this artifact id. Absent for fs-zone
   *  files (no state bridge — state is namespace-scoped). */
  stateBridge?: { artifactId: string; roomId?: string; readOnly?: boolean };
}

export function SandboxedHtmlIframe({ srcDoc, stateBridge }: SandboxedHtmlIframeProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!stateBridge) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    const teardown = installStateBridge({
      iframe,
      artifactId: stateBridge.artifactId,
      ...(stateBridge.roomId !== undefined ? { roomId: stateBridge.roomId } : {}),
      ...(stateBridge.readOnly !== undefined ? { readOnly: stateBridge.readOnly } : {}),
    });
    return teardown;
  }, [stateBridge]);

  return (
    <iframe
      ref={iframeRef}
      title="HTML document preview"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className="h-full min-h-[50vh] w-full flex-1 border-0 bg-background"
    />
  );
}
