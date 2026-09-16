import { detectHeadless } from "./headless-detect";

/** M102 — pick loopback PKCE vs device-code sign-in from host + env signals. */
export function decideAuthMode(env?: NodeJS.ProcessEnv): "loopback" | "device" {
  return detectHeadless(env).headless ? "device" : "loopback";
}
