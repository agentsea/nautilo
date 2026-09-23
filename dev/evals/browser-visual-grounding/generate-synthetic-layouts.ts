import { mkdir } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

const outputDirectory = path.join(import.meta.dir, "synthetic-layouts");

function cell(x: number, y: number, width: number, height: number, label: string, fontSize = 38): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" fill="#ede9df" stroke="#5f5a52" stroke-width="4"/>`
    + (label ? `<text x="${x + width / 2}" y="${y + height / 2 + (fontSize === 38 ? 12 : fontSize * 0.32)}" text-anchor="middle" font-family="Arial" font-size="${fontSize}" font-weight="700" fill="#38342f">${label}</text>` : "");
}

function gridSvg(options: {
  readonly width: number;
  readonly height: number;
  readonly rows: number;
  readonly columns: number;
  readonly originX: number;
  readonly originY: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly gap: number;
  readonly labels: Readonly<Record<number, string>>;
  readonly fontSize?: number;
}): string {
  const cells = Array.from({ length: options.rows * options.columns }, (_, index) => {
    const row = Math.floor(index / options.columns);
    const column = index % options.columns;
    return cell(
      options.originX + column * (options.cellWidth + options.gap),
      options.originY + row * (options.cellHeight + options.gap),
      options.cellWidth,
      options.cellHeight,
      options.labels[index] ?? "",
      options.fontSize,
    );
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}">
    <rect width="100%" height="100%" fill="#faf9f6"/>
    <text x="60" y="68" font-family="Arial" font-size="32" font-weight="700" fill="#27241f">Synthetic repeated layout</text>
    ${cells}
  </svg>`;
}

const fixtures = [
  {
    name: "grid-4x4-occupancy.png",
    svg: gridSvg({
      width: 1_000,
      height: 800,
      rows: 4,
      columns: 4,
      originX: 140,
      originY: 130,
      cellWidth: 150,
      cellHeight: 140,
      gap: 26,
      labels: { 7: "4", 10: "4" },
      fontSize: 64,
    }),
  },
  {
    name: "grid-3x5.png",
    svg: gridSvg({
      width: 1_200,
      height: 800,
      rows: 3,
      columns: 5,
      originX: 125,
      originY: 150,
      cellWidth: 150,
      cellHeight: 140,
      gap: 30,
      labels: { 2: "7", 11: "12" },
    }),
  },
  {
    name: "grid-2x3-scaled.png",
    svg: gridSvg({
      width: 1_600,
      height: 1_000,
      rows: 2,
      columns: 3,
      originX: 350,
      originY: 220,
      cellWidth: 240,
      cellHeight: 210,
      gap: 55,
      labels: { 1: "A", 5: "9" },
    }),
  },
  {
    name: "row-and-column.png",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
      <rect width="100%" height="100%" fill="#faf9f6"/>
      <text x="55" y="65" font-family="Arial" font-size="30" font-weight="700" fill="#27241f">Independent repeated controls</text>
      ${Array.from({ length: 5 }, (_, index) => cell(70 + index * 150, 125, 120, 70, String(index + 1))).join("")}
      ${Array.from({ length: 4 }, (_, index) => cell(900, 260 + index * 110, 180, 80, `R${index + 1}`)).join("")}
      <rect x="100" y="390" width="420" height="170" fill="#f2f0eb" stroke="#9a948a" stroke-width="3"/>
    </svg>`,
  },
] as const;

await mkdir(outputDirectory, { recursive: true });
for (const fixture of fixtures) {
  await sharp(Buffer.from(fixture.svg)).png({ compressionLevel: 9 }).toFile(path.join(outputDirectory, fixture.name));
}
process.stdout.write(`${fixtures.length} synthetic visual-layout fixtures written to ${outputDirectory}\n`);
