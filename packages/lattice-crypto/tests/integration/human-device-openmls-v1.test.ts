import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  seededRng,
} from "../../src/crypto/index.ts";
import { DeviceProviderStateVaultV2 } from "../../src/device/v2-state-vault.ts";
import {
  type HumanDeviceCredentialV1,
  type HumanDeviceGroupCoordinatesV1,
  HumanDeviceOpenMlsGroupV1,
  decodeHumanDeviceGroupHeadV1,
  decodeHumanDeviceGroupJoinRequestV1,
  decodeHumanDeviceGroupTransitionV1,
  decodeHumanDeviceCredentialNameV1,
  decodeHumanDeviceRosterV1,
  deriveHumanDeviceGroupIdV1,
  encodeHumanDeviceCredentialNameV1,
  encodeHumanDeviceGroupHeadV1,
  encodeHumanDeviceGroupJoinRequestV1,
  encodeHumanDeviceGroupTransitionV1,
  humanDeviceGroupHeadDigestV1,
} from "../../src/group/human-device-openmls-v1.ts";
import {
  cryptoDeviceId,
  humanId,
} from "../../src/v2-types/ids.ts";

const serverInstanceId = "018f3df1-8d42-7c59-a112-17d92f9aa111";
const otherServerInstanceId = "018f3df1-8d42-7c59-a112-17d92f9aa222";
const alice = humanId("human_alice");

function key(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function rejectionMessage(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to reject");
}

function coordinates(
  server = serverInstanceId,
): HumanDeviceGroupCoordinatesV1 {
  return Object.freeze({
    serverInstanceId: server,
    humanId: alice,
    lineageGeneration: 1,
  });
}

function credential(
  device: string,
  digestFill: number,
  generation = 1,
  server = serverInstanceId,
): HumanDeviceCredentialV1 {
  return Object.freeze({
    formatVersion: 1,
    ...coordinates(server),
    deviceId: cryptoDeviceId(device),
    installationLineageDigest: key(digestFill),
    deviceKeyGeneration: generation,
  });
}

function device(
  name: string,
  seed: number,
  digestFill: number,
  server = serverInstanceId,
) {
  const crypto = new LatticeCrypto(seededRng(seed));
  const ownCredential = credential(name, digestFill, 1, server);
  const vault = DeviceProviderStateVaultV2.fromKey(
    crypto,
    ownCredential.deviceId,
    key(seed),
  );
  return Object.freeze({
    crypto,
    group: new HumanDeviceOpenMlsGroupV1(crypto, vault, {
      coordinates: coordinates(server),
      ownCredential,
    }),
    ownCredential,
  });
}

describe("Human-device OpenMLS membership adapter", () => {
  test("binds credentials canonically to Server, Human, lineage, installation, and key generation", () => {
    const value = credential("browser_one", 7, 3);
    const encoded = encodeHumanDeviceCredentialNameV1(value);
    const decoded = decodeHumanDeviceCredentialNameV1(encoded);

    expect(decoded).toEqual(value);
    expect(() => decodeHumanDeviceCredentialNameV1(
      encoded.replace("hd1_", "v2_"),
    )).toThrow("unsupported");
    expect(() => encodeHumanDeviceCredentialNameV1({
      ...value,
      serverInstanceId: "http://localhost:3001",
    })).toThrow("canonical lowercase UUID");
    expect(() => encodeHumanDeviceCredentialNameV1({
      ...value,
      installationLineageDigest: key(9).subarray(0, 31),
    })).toThrow("32 bytes");
  });

  test("derives one group from durable Server identity rather than routing aliases", () => {
    const first = new LatticeCrypto(seededRng(11));
    const second = new LatticeCrypto(seededRng(12));

    expect(deriveHumanDeviceGroupIdV1(first, coordinates())).toBe(
      deriveHumanDeviceGroupIdV1(second, coordinates()),
    );
    expect(deriveHumanDeviceGroupIdV1(first, coordinates())).not.toBe(
      deriveHumanDeviceGroupIdV1(first, coordinates(otherServerInstanceId)),
    );
  });

  test("adds Browser and Desktop, activates Welcome, and catches an offline member up", async () => {
    const browser = device("browser_primary", 21, 1);
    const desktop = device("desktop_primary", 22, 2);
    const secondBrowser = device("browser_secondary", 23, 3);
    await Promise.all([
      browser.group.initialize(),
      desktop.group.initialize(),
      secondBrowser.group.initialize(),
    ]);

    const founded = await browser.group.createInitialState();
    expect(founded.roster.map((entry) => entry.deviceId)).toEqual([
      browser.ownCredential.deviceId,
    ]);

    const desktopJoin = await desktop.group.createJoinRequest(founded.head);
    expect(decodeHumanDeviceGroupJoinRequestV1(
      encodeHumanDeviceGroupJoinRequestV1(desktopJoin.publicResult),
    )).toEqual(desktopJoin.publicResult);
    const desktopAdd = await browser.group.prepareAdd({
      active: founded.active,
      currentHead: founded.head,
      joinRequest: desktopJoin.publicResult,
    });
    const transitionBytes = encodeHumanDeviceGroupTransitionV1(
      desktopAdd.publicResult,
    );
    const decodedTransition = decodeHumanDeviceGroupTransitionV1(
      browser.crypto,
      transitionBytes,
    );
    expect(decodedTransition).toEqual({
      ...desktopAdd.publicResult,
      welcomeBytes: new Uint8Array(),
    });
    expect(decodeHumanDeviceGroupHeadV1(
      encodeHumanDeviceGroupHeadV1(desktopAdd.publicResult.nextHead),
    )).toEqual(desktopAdd.publicResult.nextHead);
    const desktopCandidate = await desktop.group.prepareWelcome({
      joinState: desktopJoin.localState,
      joinRequest: desktopJoin.publicResult,
      transition: decodedTransition,
      welcomeBytes: desktopAdd.publicResult.welcomeBytes,
    });
    const browserAfterDesktop = browser.group.applyCandidate({
      active: founded.active,
      candidate: desktopAdd.localCandidate,
    });
    const desktopActivated = desktop.group.activateWelcome({
      candidate: desktopCandidate,
      joinState: desktopJoin.localState,
    });
    expect(browserAfterDesktop.status).toBe("applied");
    expect(desktopActivated.status).toBe("applied");
    if (
      browserAfterDesktop.status === "aborted"
      || desktopActivated.status === "aborted"
    ) throw new Error("expected active device states");

    const secondJoin = await secondBrowser.group.createJoinRequest(
      desktopAdd.publicResult.nextHead,
    );
    const secondAdd = await browser.group.prepareAdd({
      active: browserAfterDesktop.active,
      currentHead: desktopAdd.publicResult.nextHead,
      joinRequest: secondJoin.publicResult,
    });
    const desktopCatchUp = await desktop.group.prepareIncoming({
      active: desktopActivated.active,
      transition: secondAdd.publicResult,
      providerTransition: secondAdd.providerTransition,
    });
    const desktopCurrent = desktop.group.applyCandidate({
      active: desktopActivated.active,
      candidate: desktopCatchUp,
    });
    expect(desktopCurrent.status).toBe("applied");
    if (desktopCurrent.status === "aborted") {
      throw new Error("expected caught-up Desktop state");
    }
    expect(
      desktop.group.publicRoster(desktopCurrent.active).map((entry) =>
        entry.deviceId
      ),
    ).toEqual([
      browser.ownCredential.deviceId,
      desktop.ownCredential.deviceId,
      secondBrowser.ownCredential.deviceId,
    ]);

    expect(secondAdd.publicResult.nextHead.securityRevision).toBe(3);
    expect(secondAdd.publicResult.nextHead.previousHeadDigest).toEqual(
      humanDeviceGroupHeadDigestV1(
        browser.crypto,
        secondAdd.publicResult.expectedHead,
      ),
    );
    expect(
      decodeHumanDeviceRosterV1(secondAdd.publicResult.rosterBytes),
    ).toHaveLength(3);
    expect(
      "exportDomainRoots" in browser.group,
    ).toBe(false);
  });

  test("rejects a foreign-Server key package before it can become a member", async () => {
    const browser = device("browser_primary", 31, 1);
    const foreignDesktop = device(
      "desktop_foreign",
      32,
      2,
      otherServerInstanceId,
    );
    await Promise.all([
      browser.group.initialize(),
      foreignDesktop.group.initialize(),
    ]);
    const founded = await browser.group.createInitialState();
    const foreignHead = Object.freeze({
      ...founded.head,
      serverInstanceId: otherServerInstanceId,
      groupId: foreignDesktop.group.groupId,
    });
    const join = await foreignDesktop.group.createJoinRequest(foreignHead);

    expect(await rejectionMessage(() => browser.group.prepareAdd({
      active: founded.active,
      currentHead: founded.head,
      joinRequest: join.publicResult,
    }))).toContain("does not match the current group");
  });

  test("removes one exact device while preserving the remaining authenticated roster", async () => {
    const browser = device("browser_primary", 51, 1);
    const desktop = device("desktop_primary", 52, 2);
    await Promise.all([browser.group.initialize(), desktop.group.initialize()]);
    const founded = await browser.group.createInitialState();
    const join = await desktop.group.createJoinRequest(founded.head);
    const add = await browser.group.prepareAdd({
      active: founded.active,
      currentHead: founded.head,
      joinRequest: join.publicResult,
    });
    const browserAdded = browser.group.applyCandidate({
      active: founded.active,
      candidate: add.localCandidate,
    });
    const desktopWelcome = await desktop.group.prepareWelcome({
      joinState: join.localState,
      joinRequest: join.publicResult,
      transition: add.publicResult,
      welcomeBytes: add.publicResult.welcomeBytes,
    });
    const desktopAdded = desktop.group.activateWelcome({
      candidate: desktopWelcome,
      joinState: join.localState,
    });
    if (browserAdded.status === "aborted" || desktopAdded.status === "aborted") {
      throw new Error("expected added devices");
    }

    const removal = await browser.group.prepareRemove({
      active: browserAdded.active,
      currentHead: add.publicResult.nextHead,
      removedCredential: desktop.ownCredential,
    });
    const canonical = decodeHumanDeviceGroupTransitionV1(
      browser.crypto,
      encodeHumanDeviceGroupTransitionV1(removal.publicResult),
    );
    expect(canonical.operation).toBe("remove");
    expect(canonical.targetCredential.deviceId).toBe(
      desktop.ownCredential.deviceId,
    );
    expect(decodeHumanDeviceRosterV1(canonical.rosterBytes).map((entry) =>
      entry.deviceId
    )).toEqual([browser.ownCredential.deviceId]);

    const browserRemoved = browser.group.applyCandidate({
      active: browserAdded.active,
      candidate: removal.localCandidate,
    });
    expect(browserRemoved.status).toBe("applied");
    if (browserRemoved.status === "aborted") throw new Error("expected removal");
    expect(browser.group.publicRoster(browserRemoved.active).map((entry) =>
      entry.deviceId
    )).toEqual([browser.ownCredential.deviceId]);

    const desktopIncoming = await desktop.group.prepareIncoming({
      active: desktopAdded.active,
      transition: canonical,
    });
    const desktopRemoved = desktop.group.applyCandidate({
      active: desktopAdded.active,
      candidate: desktopIncoming,
    });
    expect(desktopRemoved.status).toBe("applied");
  });

  test("head bytes bind previous digest, roster digest, and security revision", async () => {
    const browser = device("browser_primary", 41, 1);
    await browser.group.initialize();
    const founded = await browser.group.createInitialState();
    const encoded = encodeHumanDeviceGroupHeadV1(founded.head);

    expect(encoded.length).toBeGreaterThan(32);
    expect(() => encodeHumanDeviceGroupHeadV1({
      ...founded.head,
      securityRevision: 0,
    })).toThrow("below its minimum");
    expect(() => encodeHumanDeviceGroupHeadV1({
      ...founded.head,
      stateHash: key(4).subarray(0, 31),
    })).toThrow("32 bytes");
  });
});
