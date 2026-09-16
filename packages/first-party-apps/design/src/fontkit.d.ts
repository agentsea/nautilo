declare module "fontkit" {
  export type GlyphPosition = {
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
  };

  export type GlyphRun = {
    glyphs: Array<{
      path: {
        transform(a: number, b: number, c: number, d: number, e: number, f: number): { toSVG(): string; bbox: { minX: number; minY: number; maxX: number; maxY: number } };
      };
    }>;
    positions: GlyphPosition[];
  };

  export type Font = {
    unitsPerEm: number;
    hasGlyphForCodePoint(codePoint: number): boolean;
    layout(text: string): GlyphRun;
  };

  export function create(buffer: Uint8Array): Font;
}
