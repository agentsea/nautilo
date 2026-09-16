import { spawn, type ChildProcess } from "node:child_process";
import type { TTSAdapter, SpeakOptions } from "../types";

export class SayAdapter implements TTSAdapter {
  private currentProcess: ChildProcess | null = null;

  async speak(text: string, options?: SpeakOptions): Promise<void> {
    this.stop();
    const cleaned = text.replace(/\[.*?\]/g, "").trim();
    if (!cleaned) return;

    const args: string[] = [];
    if (options?.rate) args.push("-r", String(options.rate));
    else args.push("-r", "185");
    if (options?.voice) args.push("-v", options.voice);

    this.currentProcess = spawn("say", [...args, cleaned], { stdio: "ignore" });

    return new Promise<void>((resolve) => {
      this.currentProcess!.on("close", () => {
        this.currentProcess = null;
        resolve();
      });
      this.currentProcess!.on("error", () => {
        this.currentProcess = null;
        resolve();
      });
    });
  }

  stop(): void {
    if (this.currentProcess) {
      this.currentProcess.kill("SIGTERM");
      this.currentProcess = null;
    }
  }

  isSpeaking(): boolean {
    return this.currentProcess !== null;
  }
}
