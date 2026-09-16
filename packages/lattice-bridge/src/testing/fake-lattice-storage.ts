import {
  InMemoryLatticeStore,
  type LatticeStorage,
} from "@nautilo/lattice-crypto";

export type FakeLatticeStorageOperation = keyof LatticeStorage;

export type FakeLatticeStorageFaultOutcome =
  | "conflict"
  | "stale"
  | "duplicate"
  | "unknown-after-commit";

export type FakeLatticeStorageFault = Readonly<{
  readonly operation: FakeLatticeStorageOperation;
  readonly outcome: FakeLatticeStorageFaultOutcome;
}>;

const STATUS_OUTCOMES = {
  compareAndSwapDomainProviderHead: ["stale", "duplicate"],
  compareAndSwapNamespaceBindingAndHead: ["stale", "duplicate"],
  compareAndSwapObjectAccessState: ["stale", "duplicate"],
  compareAndSwapAgentRuntimeChallengeReservations: ["stale", "duplicate"],
  compareAndSwapAgentRuntimeRotation: ["stale", "duplicate"],
  compareAndSwapAgentRuntimeAuthorizationTransition: [
    "stale",
    "duplicate",
  ],
  compareAndSwapRecoveryArchive: ["stale", "duplicate"],
} as const satisfies Partial<Record<
  FakeLatticeStorageOperation,
  readonly ("stale" | "duplicate")[]
>>;

export class FakeLatticeCommitOutcomeUnknown extends Error {
  readonly operation: FakeLatticeStorageOperation;

  constructor(operation: FakeLatticeStorageOperation) {
    super(`Fake lattice ${operation} commit outcome is unknown`);
    this.name = "FakeLatticeCommitOutcomeUnknown";
    this.operation = operation;
  }
}

export class FakeLatticeStorageFaults {
  readonly #maximumPendingFaults: number;
  readonly #pending: FakeLatticeStorageFault[] = [];

  constructor(maximumPendingFaults = 16) {
    if (
      !Number.isSafeInteger(maximumPendingFaults)
      || maximumPendingFaults < 1
      || maximumPendingFaults > 32
    ) {
      throw new RangeError(
        "Fake lattice maximum pending faults must be an integer from 1 through 32",
      );
    }
    this.#maximumPendingFaults = maximumPendingFaults;
  }

  enqueue(fault: FakeLatticeStorageFault): void {
    if (
      fault.outcome === "stale"
      || fault.outcome === "duplicate"
    ) {
      const supported = STATUS_OUTCOMES[
        fault.operation as keyof typeof STATUS_OUTCOMES
      ] as readonly string[] | undefined;
      if (!supported?.includes(fault.outcome)) {
        throw new TypeError(
          `Fake lattice ${fault.operation} does not support ${fault.outcome} injection`,
        );
      }
    }
    if (this.#pending.length >= this.#maximumPendingFaults) {
      throw new RangeError("Fake lattice fault queue is full");
    }
    this.#pending.push(Object.freeze({ ...fault }));
  }

  take(operation: FakeLatticeStorageOperation): FakeLatticeStorageFault | null {
    const index = this.#pending.findIndex(
      (fault) => fault.operation === operation,
    );
    if (index < 0) return null;
    return this.#pending.splice(index, 1)[0]!;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }
}

class FaultInjectingLatticeStorage implements LatticeStorage {
  constructor(
    private readonly delegate: LatticeStorage,
    private readonly faults: FakeLatticeStorageFaults,
  ) {}

  #run<Result>(
    operation: FakeLatticeStorageOperation,
    action: () => Promise<Result>,
  ): Promise<Result> {
    const fault = this.faults.take(operation);
    if (fault?.outcome === "conflict") {
      return Promise.reject(
        new Error(`Fake lattice ${operation} injected conflict`),
      );
    }
    if (fault?.outcome === "stale" || fault?.outcome === "duplicate") {
      return Promise.resolve(fault.outcome as Result);
    }
    return action().then((result) => {
      if (fault?.outcome === "unknown-after-commit") {
        throw new FakeLatticeCommitOutcomeUnknown(operation);
      }
      return result;
    });
  }

  findDomain(
    ...args: Parameters<LatticeStorage["findDomain"]>
  ): ReturnType<LatticeStorage["findDomain"]> {
    return this.#run("findDomain", () => this.delegate.findDomain(...args));
  }

  createDomainIfAbsent(
    ...args: Parameters<LatticeStorage["createDomainIfAbsent"]>
  ): ReturnType<LatticeStorage["createDomainIfAbsent"]> {
    return this.#run(
      "createDomainIfAbsent",
      () => this.delegate.createDomainIfAbsent(...args),
    );
  }

  putDomainProviderHeadIfAbsent(
    ...args: Parameters<LatticeStorage["putDomainProviderHeadIfAbsent"]>
  ): ReturnType<LatticeStorage["putDomainProviderHeadIfAbsent"]> {
    return this.#run(
      "putDomainProviderHeadIfAbsent",
      () => this.delegate.putDomainProviderHeadIfAbsent(...args),
    );
  }

  getDomainProviderHead(
    ...args: Parameters<LatticeStorage["getDomainProviderHead"]>
  ): ReturnType<LatticeStorage["getDomainProviderHead"]> {
    return this.#run(
      "getDomainProviderHead",
      () => this.delegate.getDomainProviderHead(...args),
    );
  }

  compareAndSwapDomainProviderHead(
    ...args: Parameters<LatticeStorage["compareAndSwapDomainProviderHead"]>
  ): ReturnType<LatticeStorage["compareAndSwapDomainProviderHead"]> {
    return this.#run(
      "compareAndSwapDomainProviderHead",
      () => this.delegate.compareAndSwapDomainProviderHead(...args),
    );
  }

  getBinding(
    ...args: Parameters<LatticeStorage["getBinding"]>
  ): ReturnType<LatticeStorage["getBinding"]> {
    return this.#run("getBinding", () => this.delegate.getBinding(...args));
  }

  getNamespaceHead(
    ...args: Parameters<LatticeStorage["getNamespaceHead"]>
  ): ReturnType<LatticeStorage["getNamespaceHead"]> {
    return this.#run(
      "getNamespaceHead",
      () => this.delegate.getNamespaceHead(...args),
    );
  }

  compareAndSwapNamespaceBindingAndHead(
    ...args: Parameters<
      LatticeStorage["compareAndSwapNamespaceBindingAndHead"]
    >
  ): ReturnType<LatticeStorage["compareAndSwapNamespaceBindingAndHead"]> {
    return this.#run(
      "compareAndSwapNamespaceBindingAndHead",
      () => this.delegate.compareAndSwapNamespaceBindingAndHead(...args),
    );
  }

  putObject(
    ...args: Parameters<LatticeStorage["putObject"]>
  ): ReturnType<LatticeStorage["putObject"]> {
    return this.#run("putObject", () => this.delegate.putObject(...args));
  }

  getObject(
    ...args: Parameters<LatticeStorage["getObject"]>
  ): ReturnType<LatticeStorage["getObject"]> {
    return this.#run("getObject", () => this.delegate.getObject(...args));
  }

  getObjectAccessState(
    ...args: Parameters<LatticeStorage["getObjectAccessState"]>
  ): ReturnType<LatticeStorage["getObjectAccessState"]> {
    return this.#run(
      "getObjectAccessState",
      () => this.delegate.getObjectAccessState(...args),
    );
  }

  compareAndSwapObjectAccessState(
    ...args: Parameters<LatticeStorage["compareAndSwapObjectAccessState"]>
  ): ReturnType<LatticeStorage["compareAndSwapObjectAccessState"]> {
    return this.#run(
      "compareAndSwapObjectAccessState",
      () => this.delegate.compareAndSwapObjectAccessState(...args),
    );
  }

  putAgentRuntimeAtomicStateIfAbsent(
    ...args: Parameters<
      LatticeStorage["putAgentRuntimeAtomicStateIfAbsent"]
    >
  ): ReturnType<LatticeStorage["putAgentRuntimeAtomicStateIfAbsent"]> {
    return this.#run(
      "putAgentRuntimeAtomicStateIfAbsent",
      () => this.delegate.putAgentRuntimeAtomicStateIfAbsent(...args),
    );
  }

  getAgentRuntimeAtomicState(
    ...args: Parameters<LatticeStorage["getAgentRuntimeAtomicState"]>
  ): ReturnType<LatticeStorage["getAgentRuntimeAtomicState"]> {
    return this.#run(
      "getAgentRuntimeAtomicState",
      () => this.delegate.getAgentRuntimeAtomicState(...args),
    );
  }

  getAgentRuntimeSignerPublication(
    ...args: Parameters<
      LatticeStorage["getAgentRuntimeSignerPublication"]
    >
  ): ReturnType<LatticeStorage["getAgentRuntimeSignerPublication"]> {
    return this.#run(
      "getAgentRuntimeSignerPublication",
      () => this.delegate.getAgentRuntimeSignerPublication(...args),
    );
  }

  compareAndSwapAgentRuntimeChallengeReservations(
    ...args: Parameters<
      LatticeStorage["compareAndSwapAgentRuntimeChallengeReservations"]
    >
  ): ReturnType<
    LatticeStorage["compareAndSwapAgentRuntimeChallengeReservations"]
  > {
    return this.#run(
      "compareAndSwapAgentRuntimeChallengeReservations",
      () =>
        this.delegate.compareAndSwapAgentRuntimeChallengeReservations(...args),
    );
  }

  compareAndSwapAgentRuntimeRotation(
    ...args: Parameters<
      LatticeStorage["compareAndSwapAgentRuntimeRotation"]
    >
  ): ReturnType<LatticeStorage["compareAndSwapAgentRuntimeRotation"]> {
    return this.#run(
      "compareAndSwapAgentRuntimeRotation",
      () => this.delegate.compareAndSwapAgentRuntimeRotation(...args),
    );
  }

  compareAndSwapAgentRuntimeAuthorizationTransition(
    ...args: Parameters<
      LatticeStorage[
        "compareAndSwapAgentRuntimeAuthorizationTransition"
      ]
    >
  ): ReturnType<
    LatticeStorage[
      "compareAndSwapAgentRuntimeAuthorizationTransition"
    ]
  > {
    return this.#run(
      "compareAndSwapAgentRuntimeAuthorizationTransition",
      () =>
        this.delegate
          .compareAndSwapAgentRuntimeAuthorizationTransition(...args),
    );
  }

  putGrant(
    ...args: Parameters<LatticeStorage["putGrant"]>
  ): ReturnType<LatticeStorage["putGrant"]> {
    return this.#run("putGrant", () => this.delegate.putGrant(...args));
  }

  getGrant(
    ...args: Parameters<LatticeStorage["getGrant"]>
  ): ReturnType<LatticeStorage["getGrant"]> {
    return this.#run("getGrant", () => this.delegate.getGrant(...args));
  }

  consumeGrant(
    ...args: Parameters<LatticeStorage["consumeGrant"]>
  ): ReturnType<LatticeStorage["consumeGrant"]> {
    return this.#run(
      "consumeGrant",
      () => this.delegate.consumeGrant(...args),
    );
  }

  compareAndSwapRecoveryArchive(
    ...args: Parameters<LatticeStorage["compareAndSwapRecoveryArchive"]>
  ): ReturnType<LatticeStorage["compareAndSwapRecoveryArchive"]> {
    return this.#run(
      "compareAndSwapRecoveryArchive",
      () => this.delegate.compareAndSwapRecoveryArchive(...args),
    );
  }

  getRecoveryArchive(
    ...args: Parameters<LatticeStorage["getRecoveryArchive"]>
  ): ReturnType<LatticeStorage["getRecoveryArchive"]> {
    return this.#run(
      "getRecoveryArchive",
      () => this.delegate.getRecoveryArchive(...args),
    );
  }
}

export function createFakeLatticeStorage(options: Readonly<{
  readonly maximumPendingFaults?: number;
}> = {}): Readonly<{
  readonly storage: LatticeStorage;
  readonly faults: FakeLatticeStorageFaults;
}> {
  const faults = new FakeLatticeStorageFaults(options.maximumPendingFaults);
  return Object.freeze({
    storage: new FaultInjectingLatticeStorage(
      new InMemoryLatticeStore(),
      faults,
    ),
    faults,
  });
}
