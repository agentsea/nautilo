export type ImageSize = Readonly<{ width: number; height: number }>;
export type ImageTransform = Readonly<{ scale: number; x: number; y: number }>;

export const FIT_TRANSFORM: ImageTransform = { scale: 1, x: 0, y: 0 };

export function fitImageSize(image: ImageSize, viewport: ImageSize): ImageSize {
  "worklet";
  if (![image.width, image.height, viewport.width, viewport.height].every(Number.isFinite) || image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return { width: 0, height: 0 };
  const ratio = Math.min(viewport.width / image.width, viewport.height / image.height);
  return { width: image.width * ratio, height: image.height * ratio };
}

export function clampImageTransform(transform: ImageTransform, fitted: ImageSize, viewport: ImageSize): ImageTransform {
  "worklet";
  // Scale has no artificial upper bound. The minimum preserves the fit view.
  if (![transform.scale, transform.x, transform.y, fitted.width, fitted.height, viewport.width, viewport.height].every(Number.isFinite) || fitted.width <= 0 || fitted.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return FIT_TRANSFORM;
  const scale = Math.max(1, transform.scale);
  const maxX = Math.max(0, (fitted.width * scale - viewport.width) / 2);
  const maxY = Math.max(0, (fitted.height * scale - viewport.height) / 2);
  return {
    scale,
    x: maxX === 0 ? 0 : Math.min(maxX, Math.max(-maxX, transform.x)),
    y: maxY === 0 ? 0 : Math.min(maxY, Math.max(-maxY, transform.y)),
  };
}

export function zoomImageTransform(transform: ImageTransform, multiplier: number, fitted: ImageSize, viewport: ImageSize): ImageTransform {
  "worklet";
  if (!Number.isFinite(multiplier) || multiplier <= 0) return clampImageTransform(FIT_TRANSFORM, fitted, viewport);
  return clampImageTransform({ ...transform, scale: transform.scale * multiplier }, fitted, viewport);
}
