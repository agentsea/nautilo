/**
 * D362 — image-byte resizing for `insert_image` sizing-via-bytes.
 *
 * coolwsd inserts a raster at its INTRINSIC pixel size and cannot resize
 * it afterward — `.uno:TransformDialog` `TransformWidth`/`TransformHeight`
 * are dropped/corrupted by the engine (a 1024×1024 square image came out
 * 1.39×2.45cm live; grounded in `office.ts:3107` U2 caveat + live
 * readback). The fix is to resample the image BYTES so the intrinsic
 * size equals the target cm rect at the engine's insert DPI, insert
 * that, and use `.uno:TransformDialog` for POSITION ONLY.
 *
 * `resizeImageToCm` does the resample with `jimp@1.6.1` (pure-JS, no
 * native build). It maps cm → pixels via the standard
 * `px = round(cm / 2.54 * dpi)` formula (1 inch = 2.54 cm), resizes the
 * decoded bitmap, and re-encodes as PNG. On ANY failure (jimp can't
 * decode the format, resize throws, encoding throws) it returns the
 * ORIGINAL bytes unchanged — the caller's insert still proceeds; the
 * TransformDialog-Width path is gone, so a non-resized image will land
 * at native size, but the insert itself never crashes.
 *
 * `LO_INSERT_DPI` is the ASSUMED DPI coolwsd uses when converting the
 * inserted raster's pixel dims to cm on the slide. 96 is the first
 * guess (the common screen DPI); the live calibration is: insert with
 * an explicit `{w,h}` (say 8×3cm) and `extract` → the landed cm
 * divided by the target cm is the correction factor `k`. If landed =
 * k × target, the real insert DPI = 96 × k, and `LO_INSERT_DPI` is
 * tuned to that value (one-line edit). See the office.ts insert_image
 * branch LIVE-VERIFY note for the calibration recipe.
 */
import { Jimp, JimpMime } from "jimp";

/**
 * The DPI coolwsd is ASSUMED to use when translating an inserted
 * raster's intrinsic pixel dimensions into on-slide centimetres. The
 * `resizeImageToCm` helper samples the bytes so
 * `px = round(cm/2.54 * LO_INSERT_DPI)`; the engine then renders the
 * image at `cm = px * 2.54 / LO_INSERT_DPI` — a round-trip identity
 * when the engine's real DPI matches this constant.
 *
 * LIVE-CALIBRATION PENDING (orchestrator): insert with an explicit
 * `{w,h}` (say 8×3cm) + `extract` → if the landed cm equals the target,
 * this value is correct; if landed = k × target, the real engine DPI
 * is `LO_INSERT_DPI * k` — tune this constant to that value (one-line
 * edit) and re-run the live probe until k ≈ 1.
 */
export const LO_INSERT_DPI = 96;

/**
 * Resample `bytes` so the image's intrinsic pixel dimensions equal the
 * target cm rect at the given DPI (defaults to `LO_INSERT_DPI`). Returns
 * PNG bytes (`Uint8Array`). On ANY jimp failure (decode / resize /
 * encode), returns the ORIGINAL bytes unchanged — the caller's insert
 * still proceeds; the bytes path must NEVER crash the insert.
 *
 * `px = round(cm / 2.54 * dpi)` — the standard cm→px conversion at a
 * given DPI (1 inch = 2.54 cm). The engine then renders the inserted
 * raster at `cm = px * 2.54 / dpi`, so a `LO_INSERT_DPI` matching the
 * engine's real insert DPI produces a round-trip identity (landed cm =
 * target cm). Mismatched DPI yields a consistent scale factor `k`
 * (see `LO_INSERT_DPI` doc) — the caller tunes the constant, NOT the
 * math.
 *
 * Always re-encodes as PNG (the most universally-insertable raster
 * format for coolwsd) regardless of the input format — a JPEG input
 * becomes a PNG output. This is intentional: the insert pipeline
 * treats the bytes as opaque, and re-encoding normalizes any EXIF
 * rotation / colour-profile quirks that could otherwise skew the
 * landed size.
 */
export async function resizeImageToCm(
  bytes: Uint8Array,
  targetWcm: number,
  targetHcm: number,
  dpi: number = LO_INSERT_DPI,
): Promise<Uint8Array> {
  if (!bytes || bytes.length === 0) return bytes;
  if (!Number.isFinite(targetWcm) || !Number.isFinite(targetHcm) || targetWcm <= 0 || targetHcm <= 0) {
    return bytes;
  }
  if (!Number.isFinite(dpi) || dpi <= 0) return bytes;
  const pxW = Math.round((targetWcm / 2.54) * dpi);
  const pxH = Math.round((targetHcm / 2.54) * dpi);
  if (pxW <= 0 || pxH <= 0) return bytes;
  try {
    const image = await Jimp.read(Buffer.from(bytes));
    image.resize({ w: pxW, h: pxH });
    const out = await image.getBuffer(JimpMime.png);
    return new Uint8Array(out);
  } catch {
    // Defensive: jimp failed to decode (unknown format, truncated) OR
    // resize/encode threw. The insert still proceeds with the original
    // bytes — the caller flags the gap via the result's `placedRect`
    // (which is the TARGET cm, not the actual landed cm in this case).
    // No silent deferral: the orchestrator's live calibration probe
    // surfaces any consistent mismatch as a `k != 1` factor.
    return bytes;
  }
}
