import { NativeModule, requireNativeModule } from 'expo';

declare class NautiloShareHandoffModule extends NativeModule<Record<never, never>> {
  peekAsync(): Promise<unknown>;
  ackAsync(id: string): Promise<boolean>;
  clearAsync(): Promise<void>;
  peekInboundFileAsync(): Promise<unknown>;
  openInboundFileAsync(nativeReceiptId: string): Promise<unknown>;
  ackInboundFileAsync(id: string): Promise<boolean>;
  discardInboundFileAsync(nativeReceiptId: string): Promise<boolean>;
}

export default requireNativeModule<NautiloShareHandoffModule>('NautiloShareHandoff');
