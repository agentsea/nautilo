# png-to-svg (dev)

Small wrapper around **[VTracer](https://github.com/visioncortex/vtracer)** so you can try PNG/JPEG → SVG from the repo without remembering CLI flags.

## Why VTracer

| Option | Strengths | Weaknesses |
|--------|-------------|------------|
| **VTracer** (this tool) | Open source (Rust), **color** raster to SVG, presets (`bw`, `poster`, `photo`), actively maintained | Requires a separate `vtracer` binary on PATH |
| **[Potrace](http://potrace.sourceforge.net/)** | Classic, very fast, tiny output for **binary** (B&W) art | Expects bilevel input; color logos need thresholding / posterization first |
| **npm `potrace`** | Pure Node, no binary | Still Potrace under the hood: best for B&W or posterized multi-level traces |
| **Inkscape “Trace Bitmap”** | GUI tuning | Not scripted from this repo |

For **logos with flat colors**, start with:

```bash
bun run dev/tools/png-to-svg/index.ts assets/brand/logo.png out/logo.svg -- --preset poster
```

For **simple B&W marks**:

```bash
bun run dev/tools/png-to-svg/index.ts assets/brand/mark.png out/mark.svg -- --preset bw --colormode bw
```

## Install `vtracer`

```bash
cargo install vtracer
```

Or grab a prebuilt binary from [Releases](https://github.com/visioncortex/vtracer/releases) and put it on your `PATH`.

Upstream CLI docs: [cmdapp/README.md](https://github.com/visioncortex/vtracer/blob/master/cmdapp/README.md).

## Usage

From repo root:

```bash
bun run dev/tools/png-to-svg/index.ts <input.png|jpg> <output.svg> [-- <any vtracer flags>]
```

Everything after `--` is passed straight to `vtracer`.

## Python alternative (optional)

The same project publishes **`pip install vtracer`** (native extension). Useful in notebooks; for this repo we standardize on the CLI + Bun wrapper.
