type InventoryCollectionStep = {
  readonly label: string;
  readonly collect: () => unknown;
};

type InventoryCollectionValues<
  TSteps extends readonly InventoryCollectionStep[],
> = {
  readonly [Index in keyof TSteps]: Awaited<
    ReturnType<TSteps[Index]["collect"]>
  >;
};

function collectionFailureMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export async function collectInventorySteps<
  const TSteps extends readonly InventoryCollectionStep[],
>(steps: TSteps): Promise<InventoryCollectionValues<TSteps>> {
  const results = await Promise.allSettled(
    steps.map((step) => Promise.resolve().then(() => step.collect())),
  );
  const errors = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    return [
      `${steps[index]?.label ?? `step ${index + 1}`}: `
      + collectionFailureMessage(result.reason as unknown),
    ];
  });
  if (errors.length > 0) {
    throw new Error(
      `repository inventory collection failed:\n${errors.join("\n")}`,
    );
  }
  return results.map((result) =>
    (result as PromiseFulfilledResult<unknown>).value
  ) as InventoryCollectionValues<TSteps>;
}
