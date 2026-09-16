import {
  assertCryptoAdmissionAccess,
  getCryptoAdmissionSnapshot,
  subscribeCryptoAdmissionAccess,
} from "./crypto-admission-access";

/** Protect the response body, not just the arrival of its HTTP headers. No
 * eager buffering: downloads retain backpressure and abort on invalidation. */
export class AdmissionResponse extends Response {
  private readonly responseMetadata: Readonly<{
    url: string;
    redirected: boolean;
    type: ResponseType;
  }>;

  constructor(
    source: Response,
    private readonly generation: number,
    metadata: Pick<Response, "url" | "redirected" | "type"> = source,
  ) {
    // Some fetch adapters expose an empty stream even for bodyless statuses.
    // The Response constructor requires literal null for these HTTP results.
    super(source.status === 204 || source.status === 205 || source.status === 304
      ? null : guardBody(source.body, generation), {
      status: source.status,
      statusText: source.statusText,
      headers: source.headers,
    });
    this.responseMetadata = {
      url: metadata.url,
      redirected: metadata.redirected,
      type: metadata.type,
    };
  }

  override get url(): string { return this.responseMetadata.url; }
  override get redirected(): boolean { return this.responseMetadata.redirected; }
  override get type(): ResponseType { return this.responseMetadata.type; }

  private async consume<T>(read: () => Promise<T>): Promise<T> {
    assertCryptoAdmissionAccess(this.generation);
    const value = await read();
    assertCryptoAdmissionAccess(this.generation);
    return value;
  }

  override arrayBuffer(): Promise<ArrayBuffer> { return this.consume(() => super.arrayBuffer()); }
  override blob(): Promise<Blob> { return this.consume(() => super.blob()); }
  override bytes(): Promise<Uint8Array<ArrayBuffer>> { return this.consume(() => super.bytes()); }
  override formData(): Promise<FormData> { return this.consume(() => super.formData()); }
  override json(): Promise<unknown> { return this.consume(() => super.json()); }
  override text(): Promise<string> { return this.consume(() => super.text()); }
  override clone(): Response {
    assertCryptoAdmissionAccess(this.generation);
    return new AdmissionResponse(super.clone(), this.generation, this.responseMetadata);
  }
}

function guardBody(body: ReadableStream<Uint8Array> | null, generation: number): ReadableStream<Uint8Array> | null {
  if (body === null) return null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let unsubscribe = (): void => {};
  const cancel = (reason?: unknown): void => {
    unsubscribe();
    unsubscribe = () => {};
    if (reader === null) {
      void body.cancel(reason).catch(() => undefined);
    } else {
      void reader.cancel(reason).catch(() => undefined);
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        assertCryptoAdmissionAccess(generation);
        if (reader === null) {
          reader = body.getReader();
          unsubscribe = subscribeCryptoAdmissionAccess(() => {
            if (getCryptoAdmissionSnapshot().generation === generation) return;
            try {
              assertCryptoAdmissionAccess(generation);
            } catch (error) {
              controller.error(error);
              cancel(error);
            }
          });
          assertCryptoAdmissionAccess(generation);
        }
        const result = await reader.read();
        assertCryptoAdmissionAccess(generation);
        if (result.done) {
          unsubscribe();
          controller.close();
        } else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
        cancel(error);
      }
    },
    cancel,
  }, { highWaterMark: 0 });
}
