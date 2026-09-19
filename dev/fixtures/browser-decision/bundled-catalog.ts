import { configureRuntimeModelCatalog } from "../../../packages/agent/src/config/model-catalog/runtime-catalog";

// Local qualification only: exercise this checkout's catalog before its signed release.
configureRuntimeModelCatalog({ catalogPointerUrl: null });
