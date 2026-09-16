import { Redirect } from "expo-router";

import { UserAgreementSettingsScreen } from "@/features/user-agreement/agreement-screen";
import { usePlatformCapabilities } from "@/providers/platform-capabilities";

export default function UserAgreementSettingsRoute() {
  const platform = usePlatformCapabilities().platform;
  return platform === "native"
    ? <UserAgreementSettingsScreen />
    : <Redirect href="/(drawer)/(tabs)/settings" />;
}
