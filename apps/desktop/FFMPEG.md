# FFmpeg in Nautilo Desktop

Mac Desktop includes precompiled FFmpeg 9.0.1 from iSpy's
[AgentDVR LGPL release](https://github.com/ispysoftware/agentdvr-ffmpeg-build/releases/tag/v9.0.1),
under LGPL 3 or later. Nautilo invokes its separate command-line executable;
Nautilo's own code retains its own license. Both Mac architectures use Apple's
VideoToolbox for H.264 and native AAC. GPL/nonfree components are excluded.
`--enable-version3` selects LGPLv3; it does not itself enable GPL or nonfree code.

## Source and notices included in every download

In Finder, choose **Show Package Contents** on Nautilo.app and open
`Contents/Resources/tools-ffmpeg`. It contains:

- `arm64/bin/ffmpeg` and `x64/bin/ffmpeg`, their separate `lib/` libraries and
  the supplier's `licenses/` records. The original relative library layout is
  preserved. Nautilo's release pipeline signs the executable and libraries.
- `source/`: complete FFmpeg and dependency source archives, plus build scripts
  and the supplier's RTSP patch at revision
  `a5a641ad187daad6dde58b68becabbc77be1a612` in `build-source.tar.gz`.
- `manifest.json` and `distribution.json`: exact archive, executable, library,
  source and notice hashes. `PROVENANCE.md` is this document.

The source archives travel inside every installer and updater ZIP without a
separate account or source-request step. They include their original copyright
and license notices. Included dependencies are zlib, bzip2, xz/liblzma, OpenSSL,
libogg, libvorbis, Opus, LAME, libvpx and dav1d. Apple frameworks are provided by
macOS. Exact versions and source URLs are recorded in `distribution.json` and
the matching build script. No GPL x264 source or binary is required for this
LGPL variant. The script's default is GPL: explicitly select `VARIANT=lgpl`.

To rebuild, extract `source/build-source.tar.gz` and read its `README.md`,
`build_macos.sh` and `patches/README.md`. Run `VARIANT=lgpl ./build_macos.sh` on
the appropriate Mac architecture using the documented build tools and exact
included dependency versions. The RTSP patch is part of the supplier's build;
Nautilo adds no further FFmpeg patch. The script may fetch its source inputs;
matching archives are also included in this download. Nautilo's production
pipeline consumes the pinned prebuilt binaries rather than compiling them.

Recipients retain the applicable LGPL rights to copy, modify and redistribute
FFmpeg and its source. The libraries remain separate and replaceable. To use a
modified, interface-compatible FFmpeg without Nautilo's signing keys:

1. Copy Nautilo.app to a separate writable location. Preserve the original app.
2. Replace the relevant architecture's `bin/ffmpeg` and/or `lib/*.dylib` files,
   preserving the library names and relative layout. Keep the same FFmpeg major
   library interfaces or adapt the executable and libraries together.
3. Ad-hoc sign the replaced runtime and copied app. For example, set `app` to
   the absolute path of your copied bundle and run:

   ```sh
   find "$app/Contents/Resources/tools-ffmpeg" -type f \( -name ffmpeg -o -name '*.dylib' \) -exec codesign --force --sign - {} \;
   codesign --force --deep --sign - --preserve-metadata=entitlements,flags,runtime "$app"
   ```

The runtime accepts valid ad-hoc signatures when the running app is itself
ad-hoc signed. The original production app instead requires its own signing
team. macOS may require you to approve opening the modified app and grant it
permissions again. No Nautilo signing certificate, server approval or source
request is required to replace these LGPL components. Do not redistribute a
modified app as an official signed Nautilo release; its other components retain
their respective licenses. Automatic updates can replace local modifications.

For development testing, `NAUTILO_FFMPEG_BIN` selects a rebuilt executable when
the generated managed runtime is absent and Electron is not packaged. Source
builds can also update the vendor pins and use `bun run package:mac` for an
ad-hoc signed package. These integrity checks do not revoke the included
components' license rights.

## Maintainer checks

`bun run vendor:ffmpeg` verifies the upstream ZIP, every shipped executable,
library and notice, and the corresponding-source archives. Cache hits recheck
all files. The native executable must report the approved LGPL version and
provide the image/audio/video decoders used by Nautilo. Packaging verifies the
staged distribution and signing verifies it again. Missing sources, altered
notices, missing libraries or GPL/nonfree configuration fail packaging.
Native Intel and Apple Silicon media CI exercises the actual production pin.

The old `b6.1.1` aggregator pins selected a nonredistributable arm64 executable
and a different GPL x64 executable. They are removed. Historical public
installers still require separate inventory/remediation. The earlier LGPL
8.1.2 candidate was rejected because it omitted PNG decoding, which our image
and caption workflows require.
