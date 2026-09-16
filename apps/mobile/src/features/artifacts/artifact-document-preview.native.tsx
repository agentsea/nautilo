import { buildStaticArtifactDocument } from "@nautilo/writer-proposal-core";
import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { documentNavigation } from "./artifact-document-navigation";

export function ArtifactDocumentPreview({ source }: { source: string }) {
  // A changed revision gets a fresh reader, including its navigation/retry
  // state. Source bytes stay in memory and never become an authenticated URL.
  const prepared = useMemo(() => buildStaticArtifactDocument(source), [source]);
  const [installed, setInstalled] = useState({ source, generation: 0 });
  // Do not assume metadata revision makes independently fetched bytes immutable.
  // React retries this component before committing a changed source, resetting
  // its child state even if the server reused the previous revision number.
  if (installed.source !== source) {
    setInstalled({ source, generation: installed.generation + 1 });
    return null;
  }
  if (prepared.kind !== "ready") return <Text style={styles.notice}>{prepared.message} You can still save the original from the file menu.</Text>;
  return <StaticDocument key={installed.generation} html={prepared.html} warnings={[...new Set(prepared.warnings.map((warning) => warning.message))]} />;
}

function StaticDocument({ html, warnings }: { html: string; warnings: string[] }) {
  const [generation, setGeneration] = useState(0);
  const liveGeneration = useRef(generation);
  const [failed, setFailed] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState(false);
  const requestNavigation = (url: string): boolean => {
    if (liveGeneration.current !== generation) return false;
    const decision = documentNavigation(url);
    if (decision.kind === "internal") return true;
    if (decision.kind === "confirm") { setPendingLink(decision.url); setLinkError(false); }
    return false;
  };
  const failCurrentReader = () => {
    if (liveGeneration.current === generation) setFailed(true);
  };
  return <View style={styles.reader}>
    {warnings.length > 0 && <View style={styles.chrome}>
      <Pressable accessibilityRole="button" onPress={() => setShowDetails(!showDetails)}><Text style={styles.action}>{showDetails ? "Hide document details" : "Document view details"}</Text></Pressable>
      {showDetails && <ScrollView style={styles.details}>{warnings.map((warning) => <Text key={warning} style={styles.notice}>{warning}</Text>)}</ScrollView>}
    </View>}
    {pendingLink && <View style={styles.chrome}>
      <Text style={styles.notice}>Open outside Nautilo?</Text><Text selectable style={styles.notice}>{pendingLink}</Text>
      {linkError && <Text style={styles.notice}>No application could open this link. You can copy the address above.</Text>}
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" onPress={() => setPendingLink(null)}><Text style={styles.action}>Cancel</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={() => { void Linking.openURL(pendingLink).then(() => setPendingLink(null)).catch(() => setLinkError(true)); }}><Text style={styles.action}>Open link</Text></Pressable>
      </View>
    </View>}
    {failed ? <View style={styles.chrome}>
      <Text style={styles.notice}>The document reader stopped. Your original file is unchanged.</Text>
      <Pressable accessibilityRole="button" onPress={() => { liveGeneration.current += 1; setFailed(false); setGeneration(liveGeneration.current); }}><Text style={styles.action}>Retry document</Text></Pressable>
    </View> : <WebView
      key={generation}
      accessibilityLabel="Document preview"
      style={styles.reader}
      source={{ html }}
      originWhitelist={["*"]}
      javaScriptEnabled={false}
      javaScriptCanOpenWindowsAutomatically={false}
      domStorageEnabled={false}
      geolocationEnabled={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      sharedCookiesEnabled={false}
      thirdPartyCookiesEnabled={false}
      incognito
      cacheEnabled={false}
      cacheMode="LOAD_NO_CACHE"
      mixedContentMode="never"
      saveFormDataDisabled
      allowsLinkPreview={false}
      dataDetectorTypes={["none"]}
      nestedScrollEnabled
      startInLoadingState
      renderLoading={() => <View style={styles.loading}><ActivityIndicator accessibilityLabel="Preparing document view" /><Text style={styles.notice}>Preparing document…</Text></View>}
      onShouldStartLoadWithRequest={(request) => requestNavigation(request.url)}
      onOpenWindow={(event) => { requestNavigation(event.nativeEvent.targetUrl); }}
      onError={failCurrentReader}
      onContentProcessDidTerminate={failCurrentReader}
      onRenderProcessGone={failCurrentReader}
    />}
  </View>;
}

const styles = StyleSheet.create({
  reader: { flex: 1, backgroundColor: "#fff" },
  chrome: { padding: 12, gap: 8, backgroundColor: "#f3f3f3" },
  notice: { padding: 4, color: "#222", fontSize: 14 },
  action: { padding: 8, color: "#205493", fontWeight: "600" },
  actions: { flexDirection: "row", gap: 16 },
  details: { maxHeight: "35%" },
  loading: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, justifyContent: "center", alignItems: "center", backgroundColor: "#fff" },
});
