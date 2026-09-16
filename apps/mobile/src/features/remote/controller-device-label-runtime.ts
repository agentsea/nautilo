import * as Device from "expo-device";
import { Platform } from "react-native";

import { controllerDeviceLabel } from "./controller-device-label";

export function getControllerDeviceLabel(): string {
  return controllerDeviceLabel({
    isDevice: Device.isDevice,
    modelName: Device.modelName,
    platform: Platform.OS,
  });
}
