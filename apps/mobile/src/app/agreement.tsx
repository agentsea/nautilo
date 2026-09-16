import { Redirect } from "expo-router";

import { UserAgreementGateScreen } from "@/features/user-agreement/agreement-screen";
import { usePlatformCapabilities } from "@/providers/platform-capabilities";

export default function UserAgreementRoute() {
  const platform = usePlatformCapabilities().platform;
  return platform === "native"
    ? <UserAgreementGateScreen />
    : <Redirect href="/(drawer)/(tabs)" />;
}
