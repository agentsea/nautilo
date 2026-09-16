import { join } from "node:path";
import sharp from "sharp";
import { SERVER_ICON_PRESET_IDS } from "@nautilo/types";

const OUTPUT_DIR = join(import.meta.dir, "..", "src", "onboarding", "images", "server");
const SIZE = 256;

const definitions = [
  ["preset-orbit", "#6D5EF7", "#42D3B2", '<circle cx="128" cy="128" r="38"/><ellipse cx="128" cy="128" rx="91" ry="47" fill="none" stroke-width="24" transform="rotate(-24 128 128)"/>'],
  ["preset-prism", "#F15B86", "#FFB84D", '<path d="M128 29 224 196H32Z"/><path d="m128 75 50 91H78Z" fill="#fff" fill-opacity=".28"/>'],
  ["preset-kite", "#168AAD", "#76C893", '<path d="m128 21 91 91-91 123-91-123Z"/><path d="m128 21 18 91-18 123-18-123Z" fill="#fff" fill-opacity=".3"/>'],
  ["preset-arch", "#5C7AEA", "#9B5DE5", '<path d="M35 218V121a93 93 0 0 1 186 0v97h-49v-94a44 44 0 0 0-88 0v94Z"/>'],
  ["preset-crown", "#E76F51", "#F4A261", '<path d="m31 73 62 48 35-82 35 82 62-48-25 142H56Z"/><circle cx="128" cy="170" r="22" fill="#fff" fill-opacity=".28"/>'],
  ["preset-bloom", "#D65DB1", "#FF6F91", '<path d="M128 106C73 42 30 89 67 137c-37 48 6 95 61 31 55 64 98 17 61-31 37-48-6-95-61-31Z"/><circle cx="128" cy="137" r="31" fill="#fff" fill-opacity=".3"/>'],
  ["preset-portal", "#4361EE", "#4CC9F0", '<circle cx="128" cy="128" r="94"/><circle cx="128" cy="128" r="50" fill="#fff" fill-opacity=".18"/><circle cx="128" cy="128" r="22" fill="#fff" fill-opacity=".5"/>'],
  ["preset-pulse", "#2A9D8F", "#E9C46A", '<path d="M24 137h45l24-66 36 119 31-87 20 34h52" fill="none" stroke-width="31" stroke-linecap="round" stroke-linejoin="round"/>'],
  ["preset-cube", "#735CDD", "#00B4D8", '<path d="m128 20 96 55v110l-96 55-96-55V75Z"/><path d="m32 75 96 55 96-55M128 130v110" fill="none" stroke="#fff" stroke-opacity=".32" stroke-width="18"/>'],
  ["preset-comet", "#EF476F", "#FFD166", '<path d="M57 200C16 155 38 80 98 57c45-17 93 7 110 51 18 47-8 99-57 112-35 9-72 1-94-20Z"/><path d="M23 59c43 4 78 27 96 62" fill="none" stroke-width="24" stroke-linecap="round"/>'],
  ["preset-lattice", "#3A86FF", "#8338EC", '<path d="M128 25 225 81v112l-97 56-97-56V81Z"/><path d="m79 53 98 150M177 53 79 203M31 137h194" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="17"/>'],
  ["preset-beacon", "#F77F00", "#FCBF49", '<path d="M128 22 221 216H35Z"/><path d="M128 77 88 190h80Z" fill="#fff" fill-opacity=".3"/><circle cx="128" cy="143" r="24" fill="#fff" fill-opacity=".55"/>'],
  ["preset-ripple", "#118AB2", "#06D6A0", '<circle cx="128" cy="128" r="91" fill="none" stroke-width="25"/><circle cx="128" cy="128" r="52" fill="none" stroke-width="22"/><circle cx="128" cy="128" r="19"/>'],
  ["preset-nexus", "#9C6644", "#DDB892", '<path d="M128 22 225 78v100l-97 56-97-56V78Z"/><circle cx="128" cy="128" r="43" fill="#fff" fill-opacity=".32"/><path d="M128 22v63M225 78l-55 31M225 178l-55-31M128 234v-63M31 178l55-31M31 78l55 31" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="16"/>'],
] as const;

if (
  definitions.length !== SERVER_ICON_PRESET_IDS.length ||
  definitions.some(([id], index) => id !== SERVER_ICON_PRESET_IDS[index])
) {
  throw new Error("Preset source definitions do not match SERVER_ICON_PRESET_IDS");
}

for (const [id, primary, accent, geometry] of definitions) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 256 256">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${primary}"/><stop offset="1" stop-color="${accent}"/></linearGradient></defs>
    <g fill="url(#g)" stroke="url(#g)">${geometry}</g>
  </svg>`;
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(join(OUTPUT_DIR, `${id}.png`));
}
