#!/usr/bin/env bun
/**
 * D103 P3.2/P3.3/P3.4 — derive packaged-build assets from canonical
 * brand sources at `<repo>/assets/brand/`.
 *
 * Inputs (canonical — single source of truth, shared across desktop /
 * workbench / web). Two distinct brand sources, each with a fixed role:
 *   assets/brand/nautilo-logo_v1_logo_only_dark.png        (opaque — app icon master: black background + white shell strokes, used for icon.png / icon.ico / icon.icns)
 *   assets/brand/nautilo-logo_v1_logo_only_transparent.png (RGBA — tray template master: transparent background, used for iconTemplate*.png so it stays a black alpha-only macOS template)
 *
 * Outputs (electron-builder reads these at package time; main.ts reads
 * `iconTemplate*.png` at runtime for the macOS tray):
 *   apps/desktop/assets/icon.png            (512x512 PNG, Linux)
 *   apps/desktop/assets/icon.ico            (multi-res ICO, Windows)
 *   apps/desktop/assets/icon.icns           (multi-res ICNS, macOS)
 *   apps/desktop/assets/iconTemplate.png    (22x22, solid-black + alpha — macOS menu-bar template)
 *   apps/desktop/assets/iconTemplate@2x.png (44x44 retina)
 *   apps/desktop/assets/dmg-background.png  (540x380, DMG installer backdrop)
 *   apps/desktop/assets/dmg-background@2x.png (1080x760 retina)
 *
 * Idempotent — outputs are derived from inputs; safe to re-run any time
 * the brand masters change. Wired into the `package:*` scripts so
 * packaging never goes stale on a master swap.
 *
 * Tray template-image rule (macOS): every output pixel is rendered as
 * solid black with the source's alpha preserved. macOS inverts to white
 * in dark mode automatically; only template images get that treatment,
 * which is why we reduce the colored mark to a black silhouette.
 */
import sharp from "sharp";
import png2icons from "png2icons";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const BRAND = {
  // Opaque master — black background + white shell strokes. Feeds
  // icon.png / icon.ico / icon.icns so the mark retains contrast on
  // dark system surfaces rather than exposing black strokes beneath it.
  appIcon: join(repoRoot, "assets/brand/nautilo-logo_v1_logo_only_dark.png"),
  // Transparent RGBA master — alpha-only silhouette. Feeds the
  // macOS tray template images. Must stay transparent so macOS can
  // tint it; an opaque input would bake in a black square.
  trayIcon: join(repoRoot, "assets/brand/nautilo-logo_v1_logo_only_transparent.png"),
};

// Workbench light theme --background (#faf8f5). A plain installer backdrop
// keeps the black app icon + Finder alias readable and avoids logo-on-logo.
const DMG_BACKGROUND = { r: 250, g: 248, b: 245, alpha: 1 } as const;

// A rounded black app-icon plate matches the visual language of current macOS
// and desktop icons. The source artwork stays square; this mask makes only the
// outer corners transparent and leaves the contrast-safe plate beneath the
// nautilus mark intact.
const APP_ICON_CORNER_RADIUS_RATIO = 0.22;

const OUT = {
  iconPng: join(desktopRoot, "assets/icon.png"),
  iconIco: join(desktopRoot, "assets/icon.ico"),
  iconIcns: join(desktopRoot, "assets/icon.icns"),
  trayTemplate1x: join(desktopRoot, "assets/iconTemplate.png"),
  trayTemplate2x: join(desktopRoot, "assets/iconTemplate@2x.png"),
  dmg1x: join(desktopRoot, "assets/dmg-background.png"),
  dmg2x: join(desktopRoot, "assets/dmg-background@2x.png"),
};

function note(msg: string): void {
  process.stderr.write(`[generate-icons] ${msg}\n`);
}

function roundedSquareMask(size: number): Buffer {
  const radius = Math.round(size * APP_ICON_CORNER_RADIUS_RATIO);
  return Buffer.from(
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="white"/></svg>`,
  );
}

async function generateAppIcons(): Promise<void> {
  // App icons (icon.png / icon.ico / icon.icns) use the OPAQUE dark
  // master so the packaged icon has a black plate with the white shell
  // strokes baked in. A rounded-square mask makes only the outer corners
  // transparent; the source is square, so the resize background remains
  // opaque black as belt-and-suspenders.
  note(`reading ${BRAND.appIcon}`);
  const src = sharp(BRAND.appIcon);

  // Linux: 512x512 PNG (most desktop environments derive smaller sizes).
  await src
    .clone()
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .composite([{ input: roundedSquareMask(512), blend: "dest-in" }])
    .png({ compressionLevel: 9 })
    .toFile(OUT.iconPng);
  note(`wrote ${OUT.iconPng}`);

  // For .ico / .icns we hand png2icons a 1024x1024 PNG buffer; it
  // generates the multi-res containers Electron needs.
  const masterBuffer = await src
    .clone()
    .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .composite([{ input: roundedSquareMask(1024), blend: "dest-in" }])
    .png({ compressionLevel: 9 })
    .toBuffer();

  // png2icons expects (input: Buffer, type: number, scaler: number, asObject: false)
  // Type constants: ICO_BMP / ICO_PNG / ICNS. Scaler 0 = HERMITE (good quality).
  const ico = png2icons.createICO(masterBuffer, png2icons.HERMITE, 0, false, true);
  if (!ico) throw new Error("png2icons.createICO returned null");
  writeFileSync(OUT.iconIco, ico);
  note(`wrote ${OUT.iconIco}`);

  const icns = png2icons.createICNS(masterBuffer, png2icons.HERMITE, 0);
  if (!icns) throw new Error("png2icons.createICNS returned null");
  writeFileSync(OUT.iconIcns, icns);
  note(`wrote ${OUT.iconIcns}`);
}

/**
 * Render the source mark as a macOS Template image — every visible
 * pixel becomes solid black, with the source's alpha preserved. The
 * mark's original color palette is irrelevant; only the silhouette
 * matters at menu-bar size.
 *
 * Source role: uses the TRANSPARENT `trayIcon` master
 * (nautilo-logo_v1_logo_only_transparent.png), NOT the opaque app-icon
 * master. The transparent input is what keeps the template a black
 * alpha-only silhouette; feeding the opaque dark master here would
 * bake in a solid black square and break the template.
 */
async function generateTrayTemplate(size: number, outPath: string): Promise<void> {
  // 1) Resize source to target dimensions, RGBA. Keep the transparent
  //    background (alpha 0) — do NOT flatten, or the template loses its
  //    alpha and becomes an opaque black square.
  const resized = await sharp(BRAND.trayIcon)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 2) Walk the raw RGBA buffer and replace every RGB triple with (0,0,0)
  //    while preserving the alpha byte. Anti-aliased edges stay anti-aliased,
  //    just rendered in black instead of the source palette.
  const { data, info } = resized;
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = 0;
    out[i + 1] = 0;
    out[i + 2] = 0;
    out[i + 3] = data[i + 3] ?? 0;
  }

  // 3) Re-encode raw RGBA back to PNG.
  await sharp(out, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  note(`wrote ${outPath} (${size}x${size}, black + alpha)`);
}

async function generateDmgBackground(width: number, height: number, outPath: string): Promise<void> {
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: DMG_BACKGROUND,
    },
  })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  note(`wrote ${outPath} (${width}x${height}, #faf8f5)`);
}

async function main(): Promise<number> {
  // Sanity-check the inputs exist before any work.
  for (const [k, p] of Object.entries(BRAND)) {
    try {
      readFileSync(p);
    } catch {
      note(`MISSING brand input "${k}" at ${p}`);
      return 1;
    }
  }

  mkdirSync(dirname(OUT.iconPng), { recursive: true });

  await generateAppIcons();

  // Tray: 22x22 base (macOS menu-bar standard) + 44x44 retina.
  // Electron's nativeImage convention uses `@2x` suffix to load the
  // retina variant automatically when the same path is referenced.
  await generateTrayTemplate(22, OUT.trayTemplate1x);
  await generateTrayTemplate(44, OUT.trayTemplate2x);

  await generateDmgBackground(540, 380, OUT.dmg1x);
  await generateDmgBackground(1080, 760, OUT.dmg2x);

  note("done");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[generate-icons] error: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
