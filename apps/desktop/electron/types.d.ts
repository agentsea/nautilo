import type {
  SystemPermissionId,
  SystemPermissionsSnapshot,
} from "./system-permissions";

type BinaryReadSessionErrorCode =
  | "invalid_request"
  | "not_file"
  | "not_found"
  | "size_limit"
  | "session_limit"
  | "session_not_found"
  | "sender_mismatch"
  | "out_of_order"
  | "read_in_progress"
  | "expired"
  | "mutated"
  | "unavailable";

type BinaryReadSessionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: BinaryReadSessionErrorCode } };

interface NautiloDesktopAPI {
  readonly isDesktop: true;
  readonly platform: string;
  readonly electronVersion: string;
  getVersion: () => Promise<string>;

  workbench?: {
    reload: () => Promise<void>;
    isWindowFocused?: () => boolean;
    onWindowFocusChanged?: (handler: (focused: boolean) => void) => () => void;
  };

  openFolder: () => Promise<string | null>;
  pickFiles: () => Promise<
    Array<{ name: string; sizeBytes: number; base64: string }>
  >;

  workspace: {
    getPath: () => Promise<string | null>;
  };

  relayStatus: {
    onChange: (cb: (status: string) => void) => void;
    get: () => Promise<string>;
  };

  /** D453 — narrow, human-only Codex Connection lifecycle controls. */
  codexConnection?: {
    status: () => Promise<{
      state: "disabled" | "enabling" | "enabled" | "disabling" | "faulted";
      ready: boolean;
      relayReconciliation: "acked" | "deferred" | "failed" | null;
    }>;
    enable: () => Promise<void>;
    disable: () => Promise<void>;
  };

  /** Desktop-wide, main-owned operating-system permission status and recovery. */
  systemPermissions?: {
    status: () => Promise<SystemPermissionsSnapshot>;
    resolve: (id: SystemPermissionId) => Promise<SystemPermissionsSnapshot>;
    restart: () => Promise<void>;
    onStatusChanged: (
      callback: (snapshot: SystemPermissionsSnapshot) => void,
    ) => () => void;
  };

  binaryRead: {
    open: (path: string) => Promise<BinaryReadSessionResult<{
      id: string;
      size: number;
      chunkSize: number;
    }>>;
    read: (id: string, position: number) => Promise<BinaryReadSessionResult<{
      bytes: Uint8Array;
      position: number;
      done: boolean;
    }>>;
    close: (id: string) => Promise<BinaryReadSessionResult<null>>;
  };

  fs: {
    readDir: (
      path: string,
    ) => Promise<Array<{ name: string; type: string; sizeBytes: number; mtimeMs: number }>>;
    readFile: (path: string) => Promise<string>;
    openPath: (path: string) => Promise<void>;
    watchRoot: (path: string) => Promise<void>;
    unwatchRoot: (path: string) => Promise<void>;
    onDirectoryChanged: (
      cb: (event: {
        rootPath: string;
        path: string;
        changedPath?: string;
        source?: "relay";
        op?: string;
        reloadRequired?: boolean;
        sha256?: string;
        clientMutationId?: string;
        patchEvent?: unknown;
      }) => void,
    ) => () => void;
    stat: (path: string) => Promise<{
      exists: boolean;
      isFile: boolean;
      isDirectory: boolean;
      size: number;
      modified: string | null;
    }>;
  };
}

declare global {
  interface Window {
    nautiloDesktop?: NautiloDesktopAPI;
  }
}

export {};
