# Video export settings

Approved user flow: Export video → resolution and quality → Export → native
save location. Advanced exposes a target video bitrate and audio bitrate.
Defaults are 1080p, Balanced and 192 kbps AAC. No setup or paid provider is involved.

This is an export-only choice: the saved project, source media, aspect treatment
(16:9 canvas with fit/letterboxing), timeline and sequence frame rate stay unchanged.
720p means 1280×720; 1080p means 1920×1080; 4K means 3840×2160. Upscaling cannot
restore detail missing from the source. H.264/AAC MP4 remains the output format.

Mac Desktop encodes H.264 with Apple's VideoToolbox through prebuilt LGPL FFmpeg.
Smaller/Balanced/High target 2/4/6 Mbps at 720p, 4/8/12 Mbps at 1080p and
10/20/35 Mbps at 4K. These are editable product quality presets, not admission
ceilings. Custom supplies the exact requested video bitrate. Named presets use
bitrate on both Mac architectures because VideoToolbox's quality mode is not
uniformly supported on Intel and Apple Silicon. Software encoding is permitted
within VideoToolbox when the OS cannot provide a hardware session; no different
binary or GPL encoder is retried.

Audio choices remain 128/192/320 kbps. Complexity and rate control affect the
final byte count; target bitrate is not a fixed file-size promise. Separately
provisioned non-Mac development/test FFmpeg retains the previous libx264
CRF 28/23/18 lowering; those executables are not in the Mac distribution.
See [FFmpeg VideoToolbox](https://ffmpeg.org/ffmpeg-codecs.html#VideoToolbox)
and [AAC](https://ffmpeg.org/ffmpeg-codecs.html#aac).

The same normalized settings travel from the human dialog or the app-owned
manage-video-media export-media command through the existing saved-snapshot
bridge to both native Workspace and Current Folder exporters. inspect-video-media
returns the settings attached to the active/last export; the command schema
lists supported choices. Custom bitrate starts at an editable 8 Mbps suggestion,
not an admission limit.
Genies still need the supported Desktop host and native destination selection;
no new filesystem, overwrite, server-rendering or paid-generation authority exists.
The Desktop advertises export-settings support; older hosts reject custom-profile
requests with an update message instead of silently exporting different settings.

Cancel before Export starts no native work. Dialog choices survive cancel/failure
in the open editor. Once started, the existing progress/cancellation and exclusive
publication rules apply; a completed local save is never reported as rolled back.
Malformed settings fail before source reads, encoder start or destination selection.
Old callers omitting settings retain 1080p/Balanced quality. No document migration.

Proof: shared normalization/codec tests, bridge round trips, human dialog and
Genie command tests, both native lowering paths, and short local MP4 encode/decode tests.
Packaged Desktop acceptance is a separate release gate.
