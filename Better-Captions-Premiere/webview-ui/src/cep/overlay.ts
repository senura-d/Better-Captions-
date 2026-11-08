// Renders the styled, animated captions into one transparent video clip
// (ProRes 4444 with alpha) by streaming canvas frames straight into ffmpeg.
// Only the stretch from the first caption to the last is rendered; the clip is
// then placed at that time on the timeline.

import type { AnimationConfig, CaptionItem, StyleConfig } from "../lib/types";
import { CaptionRenderer } from "../lib/canvas/engine";
import { calculateExportDimensions } from "../lib/export/exporter";
import { getCaptionsAtTime, maxConcurrentCaptions } from "../lib/transcript/parser";
import { ffmpegPath } from "./engine";

const nodeRequire: (id: string) => any =
  (window as any).cep_node?.require ?? (window as any).require;

export interface OverlayResult {
  path: string;
  start: number;
  width: number;
  height: number;
}

// Exact rates for the common NTSC frame rates, so the clip doesn't drift.
function rateArg(fps: number) {
  const ntsc: Record<string, string> = { "23.98": "24000/1001", "29.97": "30000/1001", "59.94": "60000/1001" };
  return ntsc[fps.toFixed(2)] ?? String(Math.round(fps * 1000) / 1000);
}

export async function renderOverlayVideo(
  captions: CaptionItem[],
  style: StyleConfig,
  animation: AnimationConfig,
  sequenceWidth: number,
  frameRate: number,
  outPath: string,
  onProgress: (percent: number) => void,
): Promise<OverlayResult> {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg || !nodeRequire("fs").existsSync(ffmpeg)) {
    throw new Error("ffmpeg isn't installed yet. Set up the offline engine in Offline Captions first.");
  }
  if (captions.length === 0) throw new Error("There are no captions to add.");

  const dims = calculateExportDimensions(style, sequenceWidth, animation, maxConcurrentCaptions(captions));
  const width = dims.width + (dims.width % 2);
  const height = dims.height + (dims.height % 2);

  // Start on a frame boundary so the clip lines up exactly when placed.
  const firstStart = Math.min(...captions.map((c) => c.startTime));
  const lastEnd = Math.max(...captions.map((c) => c.endTime));
  const start = Math.floor(firstStart * frameRate) / frameRate;
  const frameCount = Math.max(1, Math.ceil((lastEnd - start) * frameRate) + 1);

  // Make sure the chosen font is ready, or early frames would use a fallback font.
  await document.fonts.load(`${style.fontWeight} ${style.fontSize}px "${style.fontFamily}"`).catch(() => {});

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
  if (!ctx) throw new Error("Couldn't create a drawing canvas.");
  const renderer = new CaptionRenderer(ctx, width, height);
  const frameStyle: StyleConfig = { ...style, positionX: 0.5, positionY: 0.5 };

  const rate = rateArg(frameRate);
  const child = nodeRequire("child_process").spawn(
    ffmpeg,
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", rate, "-i", "-",
      "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0",
      outPath,
    ],
    { windowsHide: true },
  );
  let stderr = "";
  child.stderr.on("data", (d: any) => (stderr = (stderr + d.toString()).slice(-4000)));
  const finished = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code: number) => resolve(code ?? 1));
  });

  const Buffer = nodeRequire("buffer").Buffer;
  let pipeError: Error | null = null;
  child.stdin.on("error", (e: Error) => (pipeError = e));
  // Waits when ffmpeg's input buffer is full so memory stays flat on long videos.
  const write = (chunk: any) =>
    new Promise<void>((resolve, reject) => {
      if (pipeError) return reject(pipeError);
      if (!child.stdin.write(chunk)) child.stdin.once("drain", () => resolve());
      else resolve();
    });

  try {
    for (let frame = 0; frame < frameCount; frame++) {
      const time = start + frame / frameRate;
      renderer.renderFrame(getCaptionsAtTime(captions, time), time, frameStyle, animation);
      const pixels = ctx.getImageData(0, 0, width, height).data;
      await write(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength));
      if (frame % 15 === 0) {
        onProgress(Math.round((100 * frame) / frameCount));
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } finally {
    child.stdin.end();
  }

  const code = await finished;
  if (code !== 0) throw new Error(`Rendering the caption video failed: ${stderr.trim().split(/\r?\n/).pop() || `exit code ${code}`}`);
  onProgress(100);
  return { path: outPath, start, width, height };
}
