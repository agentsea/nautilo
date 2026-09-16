import { resolve } from "node:path";
import { verifyFfmpegDistribution } from "./ffmpeg-distribution";

const root = process.argv[2];
if (!root) throw new Error("usage: bun scripts/verify-ffmpeg.ts <tools-ffmpeg-directory> [--signed|--allow-resigned]");
await verifyFfmpegDistribution(resolve(root), process.argv[3] === "--signed" || process.argv[3] === "--allow-resigned", process.argv[3] === "--signed");
console.log("[ffmpeg] verified binaries, LGPL configuration, notices and complete source inputs");
