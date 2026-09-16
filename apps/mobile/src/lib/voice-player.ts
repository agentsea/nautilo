// D401 P1 — React Native TTS voice player.
//
// Mirrors the desktop VoicePlayer LOGIC
// (apps/workbench/src/adapters/voice-player.ts): per-sentence chunk
// buffering + a sequential playback queue. The desktop Web Audio API
// (AudioContext / decodeAudioData) does NOT exist in React Native, so
// playback runs on `expo-audio`: each finished sentence's concatenated MP3
// bytes are written to a temp file in the cache dir and played via
// `createAudioPlayer`, one sentence at a time.
//
// Server contract (`voice.audio`): base64 MP3 chunks stream per sentence
// (final:false), terminated by an empty-data chunk (final:true). We decode
// each chunk to BYTES and concatenate the bytes — never the base64 strings:
// each chunk is independently `=`-padded, so string-concatenation yields
// invalid base64 that fails to decode.

import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioStatus,
} from "expo-audio";
import { File, Paths } from "expo-file-system";

import { base64ToBytes } from "./base64";

/** The subset of `VoiceAudioEvent` this player consumes. */
type VoiceAudioChunk = {
  data: string;
  chunkIndex: number;
  sentenceIndex: number;
  final: boolean;
};

type StatusCallback = (playing: boolean) => void;

export class VoicePlayer {
  private enabled = false;
  private playing = false;
  private readonly onStatusChange: StatusCallback | null;

  private currentSentenceIndex = -1;
  private acceptingSentence = false;
  private chunkBuffers: Uint8Array[] = [];
  private playbackQueue: string[] = []; // temp-file URIs, one per sentence
  private draining = false;
  private currentPlayer: AudioPlayer | null = null;
  private stopped = false;

  constructor(onStatusChange?: StatusCallback) {
    this.onStatusChange = onStatusChange ?? null;
  }

  /** Enable/disable playback. Disabling stops + clears any in-flight audio. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  /**
   * Configure the audio session so TTS plays even with the ringer on silent.
   * Called on toggle-on (the RN analog of the desktop AudioContext priming).
   */
  async prime(): Promise<void> {
    try {
      await setAudioModeAsync({ playsInSilentMode: true });
    } catch {
      // best-effort — playback still works with the ringer switch off
    }
  }

  /** Feed an inbound `voice.audio` event. No-op unless enabled. */
  handleAudioEvent(event: VoiceAudioChunk): void {
    if (!this.enabled) return;

    // Require the first data chunk. A Room-inactive or voice-disabled client
    // must not assemble a truncated tail if it becomes eligible mid-sentence.
    if (event.chunkIndex === 0 && event.data) {
      this.currentSentenceIndex = event.sentenceIndex;
      this.chunkBuffers = [];
      this.acceptingSentence = true;
    }
    if (!this.acceptingSentence || event.sentenceIndex !== this.currentSentenceIndex) return;

    if (event.data) {
      try {
        this.chunkBuffers.push(base64ToBytes(event.data));
      } catch {
        // malformed chunk — skip it rather than corrupt the sentence
      }
    }

    if (event.final && this.chunkBuffers.length > 0) {
      const combined = concatBytes(this.chunkBuffers);
      this.chunkBuffers = [];
      const uri = writeTempMp3(combined);
      if (uri) {
        this.playbackQueue.push(uri);
        if (!this.draining) void this.drainQueue();
      }
    }
    if (event.final) this.acceptingSentence = false;
  }

  /** Stop playback, flush the queue + buffers. Does NOT send WS voice.stop. */
  stop(): void {
    this.stopped = true;
    this.releaseCurrent();
    for (const uri of this.playbackQueue) deleteTemp(uri);
    this.playbackQueue = [];
    this.chunkBuffers = [];
    this.draining = false;
    this.currentSentenceIndex = -1;
    this.acceptingSentence = false;
    this.setPlaying(false);
  }

  dispose(): void {
    this.stop();
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.stopped = false;
    // Force playback routing before each run — the mic recorder may have left
    // the session in record mode (allowsRecording:true), which silences media.
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldRouteThroughEarpiece: false,
      });
    } catch {
      // best-effort
    }
    this.setPlaying(true);

    while (this.playbackQueue.length > 0 && !this.stopped) {
      const uri = this.playbackQueue.shift();
      if (uri === undefined) break;
      await this.playFile(uri);
      deleteTemp(uri);
    }

    this.draining = false;
    this.setPlaying(false);
  }

  private playFile(uri: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let player: AudioPlayer;
      try {
        player = createAudioPlayer({ uri });
      } catch {
        resolve();
        return;
      }
      this.currentPlayer = player;
      let done = false;
      let started = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        try {
          sub.remove();
        } catch {
          // listener already gone
        }
        if (this.currentPlayer === player) this.currentPlayer = null;
        try {
          player.remove();
        } catch {
          // player already released
        }
        resolve();
      };
      const sub = player.addListener("playbackStatusUpdate", (status: AudioStatus) => {
        // Play only once the source is actually loaded — calling play() on an
        // unloaded player can no-op (silent).
        if (!started && status.isLoaded) {
          started = true;
          try {
            player.play();
          } catch {
            finish();
          }
        }
        if (status.didJustFinish) finish();
      });
    });
  }

  private releaseCurrent(): void {
    if (this.currentPlayer) {
      try {
        this.currentPlayer.remove();
      } catch {
        // already released
      }
      this.currentPlayer = null;
    }
  }

  private setPlaying(value: boolean): void {
    if (this.playing !== value) {
      this.playing = value;
      this.onStatusChange?.(value);
    }
  }
}

let tempSeq = 0;

function writeTempMp3(bytes: Uint8Array): string | null {
  try {
    const name = `tts-${Date.now()}-${tempSeq++}.mp3`;
    const file = new File(Paths.cache, name);
    try {
      file.create();
    } catch {
      // unique name, so this should not fire; write() below still overwrites
    }
    file.write(bytes);
    return file.uri;
  } catch {
    return null;
  }
}

function deleteTemp(uri: string): void {
  try {
    new File(uri).delete();
  } catch {
    // best-effort cleanup — the OS reaps the cache dir under storage pressure
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
