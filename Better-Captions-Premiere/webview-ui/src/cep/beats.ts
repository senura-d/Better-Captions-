// Audio for beat detection: ffmpeg decodes a file, or mixes timeline clips at
// their positions, to mono 44.1 kHz float samples (no voice filtering, which
// would dull the drums).

import { BEAT_SAMPLE_RATE } from "../lib/beats";
import type { TimelineAudioClip } from "../../../src/api/utils/engine-shared";
import { dataDir, ffmpegPath } from "./engine";

const nodeRequire: (id: string) => any =
  (window as any).cep_node?.require ?? (window as any).require;

const RATE = String(BEAT_SAMPLE_RATE);

function run(args: string[], cwd?: string, collect = false): Promise<Float32Array | null> {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg || !nodeRequire("fs").existsSync(ffmpeg)) {
    return Promise.reject(new Error("ffmpeg isn't installed yet. Set up the offline engine in Offline Captions first."));
  }
  return new Promise((resolve, reject) => {
    const child = nodeRequire("child_process").spawn(ffmpeg, args, { cwd, windowsHide: true });
    const chunks: any[] = [];
    let stderr = "";
    if (collect) child.stdout.on("data", (d: any) => chunks.push(d));
    else child.stdout.on("data", () => {});
    child.stderr.on("data", (d: any) => (stderr = (stderr + d.toString()).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code: number) => {
      if (code !== 0) return reject(new Error(`Reading the audio failed: ${stderr.trim().split(/\r?\n/).pop() || `exit code ${code}`}`));
      if (!collect) return resolve(null);
      const buf = nodeRequire("buffer").Buffer.concat(chunks);
      // Copy into a fresh, 4-byte aligned buffer for the Float32Array view.
      const floats = new Float32Array(Math.floor(buf.length / 4));
      new Uint8Array(floats.buffer).set(buf.subarray(0, floats.length * 4));
      resolve(floats);
    });
  });
}

const PCM_OUT = ["-vn", "-ac", "1", "-ar", RATE, "-f", "f32le", "pipe:1"];

// Whole audio/video file.
export async function decodeFile(path: string): Promise<Float32Array> {
  return (await run(["-nostdin", "-v", "error", "-i", path, ...PCM_OUT], undefined, true))!;
}

// Timeline clips mixed at their positions. Returns the samples and the
// timeline time they start at (the earliest clip).
export async function decodeTimeline(
  clips: TimelineAudioClip[],
  onStep: (message: string) => void,
): Promise<{ samples: Float32Array; offset: number }> {
  if (!clips.length) throw new Error("There are no audio clips to analyse.");
  const path = nodeRequire("path");
  const fs = nodeRequire("fs");
  const dir = dataDir("beats-tmp");
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true });

  const from = Math.max(0, Math.min(...clips.map((c) => c.start)));
  const to = Math.max(...clips.map((c) => c.end));
  try {
    for (let n = 0; n < clips.length; n++) {
      onStep(`Reading audio ${n + 1} of ${clips.length}`);
      const c = clips[n];
      const tempo = Math.abs(c.speed - 1) > 0.001 ? ["-af", `atempo=${Math.min(2, Math.max(0.5, c.speed)).toFixed(4)}`] : [];
      await run(["-nostdin", "-y", "-v", "error", "-ss", c.sourceIn.toFixed(3), "-t", c.sourceDuration.toFixed(3),
        "-i", c.path, "-vn", "-ac", "1", "-ar", RATE, ...tempo, `c${n}.wav`], dir);
    }
    onStep("Mixing audio");
    const parts = clips.map((c, n) => `amovie=c${n}.wav,adelay=${Math.round((c.start - from) * 1000)}:all=1[a${n}]`);
    const labels = clips.map((_, n) => `[a${n}]`).join("");
    fs.writeFileSync(path.join(dir, "mix.txt"),
      `${parts.join(";")};${labels}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,atrim=end=${(to - from).toFixed(3)}[out]`);
    const samples = await run(["-nostdin", "-v", "error", "-/filter_complex", "mix.txt", "-map", "[out]", "-ac", "1", "-ar", RATE, "-f", "f32le", "pipe:1"], dir, true);
    return { samples: samples!, offset: from };
  } finally {
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true });
  }
}
