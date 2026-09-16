const unavailableVoiceInput = {
  isRecording: false,
  startRecording: () => Promise.resolve(),
  stopAndTranscribe: () => Promise.resolve(null),
  cancelRecording: () => Promise.resolve(),
} as const;

/** Web v1 has no qualified microphone/MediaRecorder custody. */
export function useVoiceInput(_baseUrl: string | undefined): typeof unavailableVoiceInput {
  return unavailableVoiceInput;
}
