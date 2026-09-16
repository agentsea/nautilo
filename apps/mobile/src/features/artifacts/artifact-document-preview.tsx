// Mobile web retains its existing semantic Writer renderer. The native reader
// lives in the .native module; no native WebView is imported into a web bundle.
import { ScrollView } from "react-native";
import { ArtifactWriterPreview } from "./artifact-writer-preview";

export function ArtifactDocumentPreview({ source }: { source: string }) {
  return <ScrollView contentContainerStyle={{ padding: 16 }}><ArtifactWriterPreview source={source} /></ScrollView>;
}
