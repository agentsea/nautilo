import { useEffect, useRef, type ReactElement } from "react";
import { mountGeneratedMediaAmbient, type GeneratedMediaAmbientController, type GeneratedMediaAmbientState, type GeneratedMediaKind } from "@nautilo/generated-media-ui";

export interface GeneratedMediaAmbientFeedbackProps {
  mediaKind: GeneratedMediaKind;
  state: GeneratedMediaAmbientState;
  className?: string;
}

export function GeneratedMediaAmbientFeedback({ mediaKind, state, className }: GeneratedMediaAmbientFeedbackProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<GeneratedMediaAmbientController | null>(null);
  const currentState = useRef(state);
  currentState.current = state;
  useEffect(() => { controllerRef.current?.setState(state); }, [state]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const controller = mountGeneratedMediaAmbient(container, mediaKind, currentState.current);
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [mediaKind]);
  return <div ref={containerRef} className={className} />;
}
