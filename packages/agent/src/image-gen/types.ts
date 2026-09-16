export interface GenerateImagesArgs {
  readonly model: string;
  readonly prompt: string;
  readonly count: number;
  readonly size: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  readonly quality: "low" | "medium" | "high" | "auto";
  readonly background: "transparent" | "opaque" | "auto";
  readonly format: "png" | "webp" | "jpeg";
}

export interface GenerateImagesResult {
  readonly bytes: readonly Buffer[];
  readonly model: string;
  readonly mime: string;
}

export type GenerateImagesStreamEvent =
  | {
      readonly type: "partial";
      readonly b64Json: string;
      readonly partialImageIndex: number;
      readonly mime: string;
      readonly model: string;
    }
  | {
      readonly type: "completed";
      readonly b64Json: string;
      readonly mime: string;
      readonly model: string;
    };
