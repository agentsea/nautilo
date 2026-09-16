import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { ControlFrameDecoder, encodeControlFrame, encodePngAttachmentFrame } from "@nautilo/computer-use-host-protocol/node";
import type { ComputerUseHost } from "./runtime.js";

export type ComputerUseHostStdioOptions = Readonly<{
  host: ComputerUseHost;
  input: Readable;
  output: Writable;
  /** Dedicated inherited pipe. PNG frames never share the control stream. */
  attachmentOutput?: Writable;
}>;

async function write(output: Writable, bytes: Uint8Array): Promise<void> {
  if (output.write(bytes)) return;
  await once(output, "drain");
}

export async function runComputerUseHostStdio(options: ComputerUseHostStdioOptions): Promise<void> {
  const decoder = new ControlFrameDecoder();
  await write(options.output, encodeControlFrame(options.host.ready()));
  const requests = new Set<Promise<void>>();
  let writes = Promise.resolve();
  let failure: unknown;
  const publish = (response: Awaited<ReturnType<ComputerUseHost["dispatch"]>>): Promise<void> => {
    if (response === null) return Promise.resolve();
    const queued = writes.then(async () => {
      await write(options.output, encodeControlFrame(response));
      const attachment = options.host.takeAttachment(response.requestId);
      if (attachment === null) return;
      try {
        if (options.attachmentOutput === undefined) throw new Error("Computer Use Host PNG pipe is unavailable");
        await write(options.attachmentOutput, encodePngAttachmentFrame(attachment.metadata, attachment.bytes));
      } finally {
        attachment.bytes.fill(0);
      }
    });
    writes = queued.catch((error) => { failure ??= error; });
    return queued;
  };
  const schedule = (message: Parameters<ComputerUseHost["dispatch"]>[0]): void => {
    const task = options.host.dispatch(message).then(publish).catch((error) => { failure ??= error; });
    requests.add(task);
    void task.finally(() => requests.delete(task));
  };

  try {
    for await (const chunk of options.input) {
      if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) throw new Error("Computer Use Host stdin emitted unsupported bytes");
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : Uint8Array.from(chunk);
      for (const message of decoder.push(bytes)) {
        if (message.kind === "cancel") {
          // Cancellation must cross the transport while the target request is
          // still blocked; it never waits behind that request's settlement.
          await options.host.dispatch(message);
        } else if (message.kind === "request") {
          schedule(message);
        }
      }
    }
    decoder.finish();
  } finally {
    options.host.cancelAll();
    await Promise.allSettled([...requests]);
    await writes;
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error("Computer Use Host stdio failed");
}
