import type { PolicyResolver } from "@nautilo/trust";
import type { ProtectedTaskOutputReadAuthorityPort } from "./protected-task-output-read-authority";
import { createProtectedTaskWakeForegroundContextOwner } from "./protected-task-wake-foreground-context";
import {
  createProtectedTaskWakeForegroundPublication,
  type ProtectedTaskWakeForegroundPublicationInput,
  type ProtectedTaskWakePublication,
} from "./protected-task-wake-foreground-publication";
import { createProtectedTaskWakeLifecycle, type ProtectedTaskWakeLifecycle } from "./protected-task-wake-lifecycle";

/** Compose fresh product authority with the ordinary Room context and the wake-only grant. */
export function createProtectedTaskWakeForegroundComposition(input:
  Omit<ProtectedTaskWakeForegroundPublicationInput, "createLifecycle" | "withForegroundContext"> & Readonly<{
    authority: ProtectedTaskOutputReadAuthorityPort;
    resolver: PolicyResolver;
  }>) {
  const lifetimes = new WeakMap<ProtectedTaskWakePublication, ProtectedTaskWakeLifecycle>();
  const context = createProtectedTaskWakeForegroundContextOwner({ resolver: input.resolver,
    withCurrentFacts: request => {
      const lifecycle = lifetimes.get(request.publication);
      return lifecycle === undefined ? Promise.resolve(null) : lifecycle.withCurrentFacts(request);
    } });
  return createProtectedTaskWakeForegroundPublication({ ...input,
    createLifecycle: async publication => {
      const lifecycle = await createProtectedTaskWakeLifecycle({ publication,
        authority: input.authority, restricted: input.restricted });
      if (lifecycle === null) return null;
      lifetimes.set(publication, lifecycle);
      return Object.freeze({ ...lifecycle, dispose: () => {
        lifetimes.delete(publication);
        lifecycle.dispose();
      } });
    },
    withForegroundContext: context,
  });
}
