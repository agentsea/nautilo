import { handOverBolterBatch, parseBolterHandoverDescriptor } from "./handover";

/** App-owned helper entry point, compiled/provisioned separately from Electron main. */
export async function runBolterHandover(input: AsyncIterable<Uint8Array>, descriptorText: string | undefined): Promise<number> {
  const descriptor = descriptorText ? parseBolterHandoverDescriptor(descriptorText) : null;
  return descriptor && await handOverBolterBatch(descriptor, input) ? 0 : 1;
}
if (import.meta.main) {
  // The generation secret never appears in argv, stdout, stderr or logs.
  const descriptor = process.env["NAUTILO_BOLTER_HANDOVER"];
  delete process.env["NAUTILO_BOLTER_HANDOVER"];
  process.exitCode = await runBolterHandover(process.stdin, descriptor);
}
