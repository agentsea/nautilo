import { registerWebModule, NativeModule } from 'expo';

class NautiloShareHandoffModule extends NativeModule<Record<never, never>> {
  peekAsync(): Promise<null> { return Promise.resolve(null); }
  ackAsync(_id: string): Promise<boolean> { return Promise.resolve(false); }
  clearAsync(): Promise<void> { return Promise.resolve(); }
}

export default registerWebModule(NautiloShareHandoffModule, 'NautiloShareHandoffModule');
