import { NativeModule, requireOptionalNativeModule } from "expo";

export type PcmStatus = {
  streamId: string;
  consumedSamples: number;
  playing: boolean;
  ended: boolean;
  error?: string;
};
export interface NativePcmSink {
  begin(streamId: string): Promise<void>;
  write(streamId: string, pcm: Uint8Array): Promise<void>;
  finish(streamId: string): Promise<void>;
  stop(streamId: string): Promise<void>;
  addListener(event: "status", listener: (status: PcmStatus) => void): { remove(): void };
}
declare class VoicePcmModule extends NativeModule<{ status: (status: PcmStatus) => void }> implements NativePcmSink {
  begin(streamId: string): Promise<void>;
  write(streamId: string, pcm: Uint8Array): Promise<void>;
  finish(streamId: string): Promise<void>;
  stop(streamId: string): Promise<void>;
}
export const nativePcmSink = requireOptionalNativeModule<VoicePcmModule>("NautiloVoicePcm");
