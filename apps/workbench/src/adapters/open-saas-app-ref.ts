export interface SaasAppTarget {
  appId: string;
  displayName: string;
  initialUrl: string;
  mode?: "app" | "browser";
}

type OpenSaasAppDispatcher = (target: SaasAppTarget) => void;

let dispatcher: OpenSaasAppDispatcher | null = null;

export function setOpenSaasAppDispatcher(fn: OpenSaasAppDispatcher | null): void {
  dispatcher = fn;
}

export function requestOpenSaasApp(target: SaasAppTarget): boolean {
  if (!dispatcher || target.appId.length === 0 || target.initialUrl.length === 0) {
    return false;
  }
  dispatcher(target);
  return true;
}
