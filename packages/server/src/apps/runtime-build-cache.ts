import {
  buildMiniApp,
  miniAppRuntimeBuildCacheKey,
  type MiniAppBuildResult,
} from "./app-builder";
import type { RegisteredMiniApp } from "./app-registry";

export interface MiniAppRuntimeBuildCacheDeps {
  build?: typeof buildMiniApp;
}

type SuccessfulMiniAppBuild = Extract<MiniAppBuildResult, { ok: true }>;

function cloneSuccessfulBuild(result: SuccessfulMiniAppBuild): SuccessfulMiniAppBuild {
  return {
    ...result,
    styles: result.styles.map((style) => ({ ...style })),
    manifest: structuredClone(result.manifest),
    agentToolsBuild: structuredClone(result.agentToolsBuild),
  };
}

function cloneBuildResult(result: MiniAppBuildResult): MiniAppBuildResult {
  return result.ok ? cloneSuccessfulBuild(result) : result;
}

/**
 * In-memory single-flight and success cache for mini-app runtime builds.
 * Keys are scoped to appId + sourceHash + deterministic toolchain identity.
 */
export class MiniAppRuntimeBuildCache {
  private readonly buildFn: typeof buildMiniApp;
  private readonly successCache = new Map<string, SuccessfulMiniAppBuild>();
  private readonly inFlight = new Map<string, Promise<MiniAppBuildResult>>();

  constructor(deps?: MiniAppRuntimeBuildCacheDeps) {
    this.buildFn = deps?.build ?? buildMiniApp;
  }

  async build(app: RegisteredMiniApp, appsRoot: string): Promise<MiniAppBuildResult> {
    const sourceHash = app.sourceHash;
    if (!sourceHash) {
      return this.buildFn(app, appsRoot);
    }

    const key = miniAppRuntimeBuildCacheKey(app.id, sourceHash);
    const cached = this.successCache.get(key);
    if (cached) {
      return cloneSuccessfulBuild(cached);
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing.then(cloneBuildResult);
    }

    const promise = this.buildFn(app, appsRoot)
      .then((result) => {
        if (result.ok) {
          this.successCache.set(key, result);
        }
        return cloneBuildResult(result);
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }
}
