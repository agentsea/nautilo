import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ApiError } from "@nautilo/api-client/browser";
import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";

const calls = {
  export: 0,
  plan: 0,
  stage: 0,
  commit: 0,
  commitKeys: [] as string[],
  planInputs: [] as Array<{ bundle: { records: readonly Record<string, unknown>[] } }>,
};

let decrypted: {
  bundle: { scopes: readonly ("profile" | "avatar" | "privateMemories" | "privateArtifacts")[]; records: readonly Record<string, unknown>[] };
  avatarBytes: Uint8Array | null;
  avatarMedia: { mediaEntry: string; mimeType: string } | null;
  dek: Uint8Array;
};
let firstCommitFails = false;
let commitFailure: unknown = null;
let exportGate: Promise<void> | null = null;

const plan = {
  planToken: "restore-plan",
  semanticRoot: "root",
  targetStateDigest: "digest",
  targetAgentId: "not-rendered",
  destinationInstanceId: "not-rendered",
  scopes: ["profile", "avatar", "privateMemories"] as const,
  wholeProfileChoice: "source" as const,
  conflicts: [],
  avatarMedia: { mediaEntry: "avatar.bin", sha256: "a".repeat(64), mimeType: "image/png" },
  privateMemoryCount: 3,
  privateMemoryAddedCount: 2,
  privateMemoryAlreadyPresentCount: 1,
  privateArtifactCount: 0,
  privateArtifactBytes: 0,
  refused: [],
  unknown: [],
  expiresAt: "2099-01-01T00:00:00.000Z",
};
let planAvatarMedia: typeof plan.avatarMedia | null;

mock.module("../../../lib/api", () => ({
  apiClient: {
    exportProfileBundle: async () => { calls.export += 1; await exportGate; return { bundleId: "export", semanticVersion: { major: 1, minor: 1 }, scopes: ["profile"], records: [], avatarMedia: null }; },
    downloadProfileBundleMedia: async () => new Blob(),
    whoami: async () => ({ instanceId: "this-instance" }),
    planProfileBundleImport: async (input: { bundle: { records: readonly Record<string, unknown>[] } }) => {
      calls.plan += 1;
      calls.planInputs.push(input);
      const avatar = input.bundle.records.find((record) => record.recordKind === "avatar");
      return { plan: { ...plan, avatarMedia: avatar?.avatar === null ? null : planAvatarMedia } };
    },
    stageProfileBundleAvatar: async () => { calls.stage += 1; return { staged: true }; },
    commitProfileBundleImport: async ({ idempotencyKey }: { idempotencyKey: string }) => {
      calls.commit += 1;
      calls.commitKeys.push(idempotencyKey);
      if (commitFailure !== null && calls.commit === 1) throw commitFailure;
      if (firstCommitFails && calls.commit === 1) throw new Error("network interrupted");
      return { committed: true, privateMemoryAddedCount: 2, privateMemoryAlreadyPresentCount: 1 };
    },
  },
}));

mock.module("../../../lib/profile-bundle-browser", () => ({
  createProfileBundleBrowserCrypto: () => ({ argon2id: async () => new Uint8Array(32), dispose: () => undefined }),
  decryptBrowserProfileBundle: async () => decrypted,
  encryptBrowserProfileBundle: async () => "encrypted",
  disposeDecryptedProfileBundle: (value: { dek: Uint8Array }) => value.dek.fill(0),
  wipeProfileBundleSecret: (value: Uint8Array) => value.fill(0),
}));

const { GenieBackupRestore } = await import("./genie-backup-restore");

function reset() {
  calls.export = 0;
  calls.plan = 0;
  calls.stage = 0;
  calls.commit = 0;
  calls.commitKeys = [];
  calls.planInputs = [];
  firstCommitFails = false;
  commitFailure = null;
  exportGate = null;
  planAvatarMedia = plan.avatarMedia;
  decrypted = {
    bundle: {
      scopes: ["profile", "avatar", "privateMemories"],
      records: [
        { recordKind: "identity", name: "Moxie", handleIntent: "moxie" },
        { recordKind: "avatar", avatar: { mediaEntry: "media/avatar.bin", mimeType: "image/png", sha256: "a".repeat(64), width: null, height: null } },
      ],
    },
    avatarBytes: new Uint8Array([1, 2, 3]),
    avatarMedia: { mediaEntry: "avatar.bin", mimeType: "image/png" },
    dek: new Uint8Array(32).fill(7),
  };
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  reset();
  if (!crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", { value: () => "stable-retry-key" });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:backup" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
});

afterEach(cleanup);

function openRestore() {
  const view = render(<GenieBackupRestore onRestored={() => undefined} />);
  fireEvent.click(view.getByRole("button", { name: "Restore backup" }));
  return view;
}

/** happy-dom does not propagate fireEvent.change to controlled password inputs. */
async function typeInControlledInput(input: HTMLInputElement, value: string): Promise<void> {
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props not found on password input");
  const props = (input as HTMLInputElement & Record<string, unknown>)[propsKey] as {
    onChange: (event: { target: { value: string }; currentTarget: { value: string } }) => void;
  };
  await act(async () => { props.onChange({ target: { value }, currentTarget: { value } }); });
}

async function selectAndReview(view: ReturnType<typeof render>) {
  const file = new File(["backup"], "backup.nautilo-profile.json", { type: "application/json" });
  const input = view.getByLabelText("Backup file") as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: { 0: file, length: 1 } });
  fireEvent.change(input);
  await typeInControlledInput(view.getByLabelText("Backup password") as HTMLInputElement, "secret");
  await waitFor(() => expect((view.getByLabelText("Backup password") as HTMLInputElement).value).toBe("secret"));
  fireEvent.click(view.getByRole("button", { name: "Review backup" }));
}

describe("GenieBackupRestore", () => {
  test("keeps a mismatched download password local", async () => {
    const view = render(<GenieBackupRestore onRestored={() => undefined} />);
    fireEvent.click(view.getByRole("button", { name: "Download backup" }));
    await typeInControlledInput(view.getByLabelText("Backup password") as HTMLInputElement, "one");
    await typeInControlledInput(view.getByLabelText("Confirm backup password") as HTMLInputElement, "two");
    await waitFor(() => expect((view.getByLabelText("Confirm backup password") as HTMLInputElement).value).toBe("two"));
    fireEvent.click(view.getAllByRole("button", { name: "Download backup" })[1]!);
    expect(await view.findByText("The two backup passwords do not match.")).toBeTruthy();
    expect(calls.export).toBe(0);
  });

  test("shows truthful staged progress and a distinct completed state while downloading", async () => {
    let releaseExport!: () => void;
    exportGate = new Promise<void>((resolve) => { releaseExport = resolve; });
    const view = render(<GenieBackupRestore onRestored={() => undefined} />);
    fireEvent.click(view.getByRole("button", { name: "Download backup" }));
    await typeInControlledInput(view.getByLabelText("Backup password") as HTMLInputElement, "secret");
    await typeInControlledInput(view.getByLabelText("Confirm backup password") as HTMLInputElement, "secret");
    fireEvent.click(view.getAllByRole("button", { name: "Download backup" })[1]!);

    expect(await view.findByText("Step 1 of 3: Collect Genie data")).toBeTruthy();
    expect(view.getByText(/seconds elapsed\. Usually a few seconds/i)).toBeTruthy();
    expect(view.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("Step 1 of 3: Collect Genie data");

    await act(async () => { releaseExport(); });
    expect(await view.findByText(/Downloaded an encrypted backup/i)).toBeTruthy();
    await waitFor(() => expect(view.getByRole("dialog").getAttribute("aria-busy")).toBe("false"));
    expect(view.queryByLabelText("Backup password")).toBeNull();
    expect(view.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  test("rejects artifact-bearing backups before contacting the server", async () => {
    decrypted.bundle = { scopes: ["profile", "privateArtifacts"], records: [{ recordKind: "artifact" }] };
    const view = openRestore();
    await selectAndReview(view);
    expect(await view.findByText(/contains artifacts/i)).toBeTruthy();
    await waitFor(() => expect(view.getByRole("dialog").getAttribute("aria-busy")).toBe("false"));
    expect(calls.plan).toBe(0);
  });

  test("does not let the native file picker filter out a downloaded backup", () => {
    const view = openRestore();
    const input = view.getByLabelText("Backup file") as HTMLInputElement;
    expect(input.hasAttribute("accept")).toBe(false);
    expect(view.getByText("Choose the encrypted backup file Nautilo downloaded.")).toBeTruthy();
  });

  test("reviews count-only changes and stages an avatar once across an uncertain commit retry", async () => {
    firstCommitFails = true;
    let refreshes = 0;
    const view = render(<GenieBackupRestore onRestored={() => { refreshes += 1; }} />);
    fireEvent.click(view.getByRole("button", { name: "Restore backup" }));
    await selectAndReview(view);
    expect(await view.findByText((_, element) => element?.textContent === "Merge: 2 new, 1 already here")).toBeTruthy();
    expect(view.getByText(/never deletes or overwrites existing private memories/i)).toBeTruthy();
    fireEvent.click(view.getAllByRole("button", { name: "Restore backup" })[1]!);
    expect(await view.findByText(/could not confirm/i)).toBeTruthy();
    fireEvent.click(view.getAllByRole("button", { name: "Restore backup" })[1]!);
    expect(await view.findByRole("heading", { name: "Backup restored" })).toBeTruthy();
    await waitFor(() => expect(view.getByRole("dialog").getAttribute("aria-busy")).toBe("false"));
    expect(calls.stage).toBe(1);
    expect(calls.commit).toBe(2);
    expect(calls.commitKeys[0]).toBe(calls.commitKeys[1]);
    expect(refreshes).toBe(1);
  });

  test("binds the edited name and avatar choice into the final restore plan", async () => {
    const view = openRestore();
    await selectAndReview(view);

    const name = await view.findByLabelText("Genie name") as HTMLInputElement;
    expect(name.value).toBe("Moxie");
    expect(view.getByRole("radio", { name: /Use backed-up avatar/ })).toBeTruthy();
    await typeInControlledInput(name, "Nova");
    fireEvent.click(view.getByRole("radio", { name: "Keep current avatar" }));
    fireEvent.click(view.getAllByRole("button", { name: "Restore backup" })[1]!);

    expect(await view.findByRole("heading", { name: "Backup restored" })).toBeTruthy();
    const finalRecords = calls.planInputs.at(-1)!.bundle.records;
    const identity = finalRecords.find((record) => record.recordKind === "identity");
    expect(identity?.name).toBe("Nova");
    expect(identity?.handleIntent).toBeNull();
    expect(finalRecords.find((record) => record.recordKind === "avatar")?.avatar).toBeNull();
    expect(calls.plan).toBe(2);
    expect(calls.stage).toBe(0);
    expect(calls.commit).toBe(1);
  });

  test("keeps the backed-up avatar selectable when its preview cannot be created", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => { throw new Error("preview unavailable"); },
    });
    const view = openRestore();
    await selectAndReview(view);

    expect(await view.findByRole("radio", { name: "Use backed-up avatar" })).toBeTruthy();
    expect(view.queryByAltText("Backed-up avatar")).toBeNull();
  });

  test("tells the user an omitted avatar will be preserved", async () => {
    decrypted.avatarBytes = null;
    decrypted.avatarMedia = null;
    planAvatarMedia = null;
    const view = openRestore();
    await selectAndReview(view);

    expect(await view.findByText("This backup has no avatar. Your current avatar will be kept.")).toBeTruthy();
    expect(view.queryByText("Not in this backup")).toBeNull();
    expect(calls.stage).toBe(0);
  });

  test("shows a plain server rejection for a non-stale conflict instead of an uncertain retry", async () => {
    commitFailure = new ApiError(409, "idempotency_conflict");
    const view = openRestore();
    await selectAndReview(view);
    await view.findByText((_, element) => element?.textContent === "Merge: 2 new, 1 already here");
    fireEvent.click(view.getAllByRole("button", { name: "Restore backup" })[1]!);
    expect(await view.findByText(/restore was declined by the server/i)).toBeTruthy();
    await waitFor(() => expect(view.getByRole("dialog").getAttribute("aria-busy")).toBe("false"));
    expect(view.queryByText(/could not confirm whether the restore finished/i)).toBeNull();
  });
});
