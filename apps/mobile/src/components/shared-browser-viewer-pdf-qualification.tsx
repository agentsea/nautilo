import { Text } from "react-native";

export interface SharedBrowserViewerPdfQualificationProps {
  readonly onBeforeRender?: () => void;
  readonly onRegisterCleanup?: (cleanup: (() => void) | undefined) => void;
}

/** TypeScript's platform-neutral fallback; native and Web resolve their facades. */
export function SharedBrowserViewerPdfQualification(_props: SharedBrowserViewerPdfQualificationProps) {
  return <Text>PDF render qualification is available on Web only.</Text>;
}
