#!/usr/bin/env bash

set -euo pipefail

if ! command -v magick >/dev/null 2>&1; then
  echo "ImageMagick's 'magick' command is required to generate mobile release icons." >&2
  exit 1
fi

mobile_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_icon="$mobile_root/assets/images/icon.png"
output_dir="$mobile_root/assets/images"
icon_tmp="$(mktemp -d "${TMPDIR:-/tmp}/nautilo-release-icons.XXXXXX")"

cleanup() {
  rm -rf "$icon_tmp"
}
trap cleanup EXIT

render_centered_mark() {
  local color="$1"
  local max_size="$2"
  local output="$3"

  magick \
    -size 1024x1024 "xc:${color}" \
    \( "$icon_tmp/alpha.png" \) \
    -alpha off \
    -compose CopyOpacity \
    -composite \
    -trim \
    +repage \
    -resize "${max_size}x${max_size}" \
    -gravity center \
    -background none \
    -extent 1024x1024 \
    -channel RGB \
    -fill "$color" \
    -colorize 100 \
    +channel \
    -strip \
    +set date:create \
    +set date:modify \
    -define png:exclude-chunk=time \
    "$output"
}

# The canonical icon is black line art on white. Inverting its luminance yields
# the reusable alpha mask without preserving the old opaque white square.
magick "$source_icon" -colorspace gray -negate "$icon_tmp/alpha.png"

# Android adaptive foregrounds must leave room for launcher masks and motion.
# The mark's longest edge is capped at 660px on the 1024px source canvas.
render_centered_mark black 660 "$icon_tmp/android-icon-foreground.png"

# Android 13+ themed icons consume a single-color alpha mask. White makes that
# intent explicit while keeping the mask independent of the normal foreground.
render_centered_mark white 660 "$icon_tmp/android-icon-monochrome.png"

# Splash artwork is allowed to breathe more because Expo sizes it independently
# with imageWidth. It remains transparent so no boxed tile appears at launch.
render_centered_mark black 760 "$icon_tmp/splash-icon.png"

for generated_icon in \
  android-icon-foreground.png \
  android-icon-monochrome.png \
  splash-icon.png; do
  geometry="$(magick identify -format '%wx%h' "$icon_tmp/$generated_icon")"
  if [ "$geometry" != "1024x1024" ]; then
    echo "$generated_icon has invalid geometry: $geometry" >&2
    exit 1
  fi

  opaque="$(magick identify -format '%[opaque]' "$icon_tmp/$generated_icon")"
  if [ "$opaque" != "False" ]; then
    echo "$generated_icon must retain transparency." >&2
    exit 1
  fi
done

foreground_hash="$(shasum -a 256 "$icon_tmp/android-icon-foreground.png" | awk '{print $1}')"
monochrome_hash="$(shasum -a 256 "$icon_tmp/android-icon-monochrome.png" | awk '{print $1}')"
splash_hash="$(shasum -a 256 "$icon_tmp/splash-icon.png" | awk '{print $1}')"

if [ "$foreground_hash" = "$monochrome_hash" ] || [ "$foreground_hash" = "$splash_hash" ]; then
  echo "Release icon roles must produce distinct assets." >&2
  exit 1
fi

cp "$icon_tmp/android-icon-foreground.png" "$output_dir/android-icon-foreground.png"
cp "$icon_tmp/android-icon-monochrome.png" "$output_dir/android-icon-monochrome.png"
cp "$icon_tmp/splash-icon.png" "$output_dir/splash-icon.png"

echo "Generated Android foreground, Android monochrome, and splash assets."
