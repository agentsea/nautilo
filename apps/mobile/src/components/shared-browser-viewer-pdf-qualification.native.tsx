import { Text } from "react-native";

import type { SharedBrowserViewerPdfQualificationProps } from "./shared-browser-viewer-pdf-qualification";

/** Native is deliberately fail-closed: no browser PDF runtime can resolve here. */
export function SharedBrowserViewerPdfQualification(_props: SharedBrowserViewerPdfQualificationProps) {
  return <Text>PDF render qualification is available on Web only.</Text>;
}
