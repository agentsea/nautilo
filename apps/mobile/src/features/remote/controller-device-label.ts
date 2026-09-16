const MAX_LABEL_LENGTH = 200;

export interface ControllerDeviceFacts {
  readonly isDevice: boolean;
  readonly modelName: string | null;
  readonly platform: string;
}

export function controllerDeviceLabel(facts: ControllerDeviceFacts): string {
  const platformLabel =
    facts.platform === "ios"
      ? "iPhone"
      : facts.platform === "android"
        ? "Android phone"
        : "Mobile device";
  const modelName = facts.modelName?.trim();
  const label = facts.isDevice && modelName
    ? modelName
    : facts.isDevice
      ? platformLabel
      : `${platformLabel} simulator`;
  return label.slice(0, MAX_LABEL_LENGTH);
}
