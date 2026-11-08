// Offline captioning for the CEP extension. CEP panels run Node.js, so ffmpeg
// and whisper.cpp are spawned directly with argument arrays (no shell) and the
// job state lives in memory while the panel polls it.

import {
  FFMPEG_WIN_BYTES,
  FFMPEG_WIN_URL,
  MAC_BIN_DIRS,
  MIX_ARGS,
  MODEL_BASE_URL,
  OFFLINE_MODELS,
  VAD_MODEL_BYTES,
  VAD_MODEL_FILE,
  VAD_MODEL_URL,
  WHISPER_WIN_BYTES,
  WHISPER_WIN_URL,
  extractArgs,
  fileToWavArgs,
  isValidLanguage,
  mixFilter,
  parseSpeechSpans,
  whisperArgs,
  type OfflineEngineStatus,
  type OfflineJobStatus,
  type SpeechSpan,
  type TimelineAudioClip,
} from "../../../src/api/utils/engine-shared";

const nodeRequire: (id: string) => any =
  (window as any).cep_node?.require ?? (window as any).require;

const fs = () => nodeRequire("fs");
const path = () => nodeRequire("path");
const os = () => nodeRequire("os");
const childProcess = () => nodeRequire("child_process");

const env = (): Record<string, string | undefined> =>
  ((window as any).cep_node?.process ?? (globalThis as any).process)?.env ?? {};

const isWin = () => os().platform() === "win32";

export const hasNode = () => typeof nodeRequire === "function";

export function dataDir(...parts: string[]) {
  const base = isWin()
    ? path().join(env().APPDATA || os().homedir(), "BetterCaptions")
    : path().join(os().homedir(), "Library", "Application Support", "BetterCaptions");
  const dir = path().join(base, ...parts);
  fs().mkdirSync(dir, { recursive: true });
  return dir;
}

function enginePaths() {
  const root = dataDir("engine");
  const modelPath = (key: string) => path().join(root, "models", OFFLINE_MODELS[key].file);
  const vadModel = path().join(root, "models", VAD_MODEL_FILE);
  if (isWin()) {
    return {
      root,
      whisper: path().join(root, "bin", "whisper-cli.exe"),
      ffmpeg: path().join(root, "ffmpeg", "ffmpeg.exe"),
      modelPath,
      vadModel,
    };
  }
  const findMac = (name: string) =>
    MAC_BIN_DIRS.map((d) => `${d}/${name}`).find((p) => fs().existsSync(p)) ?? "";
  return { root, whisper: findMac("whisper-cli"), ffmpeg: findMac("ffmpeg"), modelPath, vadModel };
}

// Files unpacked from zips can be read-only on Windows, which makes a plain
// recursive delete fail. Clear the flag and retry; never fail a job over cleanup.
function removeDir(dir: string) {
  const f = fs();
  try {
    f.rmSync(dir, { recursive: true, force: true });
    return;
  } catch {}
  const makeWritable = (p: string) => {
    try {
      f.chmodSync(p, 0o666);
      if (f.statSync(p).isDirectory()) for (const name of f.readdirSync(p)) makeWritable(path().join(p, name));
    } catch {}
  };
  makeWritable(dir);
  try {
    f.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn("Could not remove", dir, e);
  }
}

export const ffmpegPath = () => enginePaths().ffmpeg;

// ---------- jobs ----------

interface Job {
  status: OfflineJobStatus;
  child: any | null;
  cancelled: boolean;
  dir: string;
  result?: string;
  skipped: string[];
  speechSpans: SpeechSpan[];
  offset: number;
  // Multi-track jobs: one transcription per track.
  trackResults?: { label: string; json: string; speechSpans: SpeechSpan[]; offset: number }[];
}

const jobs = new Map<string, Job>();

class CancelledError extends Error {}

function newJob(kind: string) {
  const id = `${kind}-${Date.now().toString(36)}`;
  const dir = dataDir("jobs", id);
  const job: Job = {
    status: { state: "running", stage: "", progress: -1, message: "Starting…" },
    child: null,
    cancelled: false,
    dir,
    skipped: [],
    speechSpans: [],
    offset: 0,
  };
  jobs.set(id, job);
  return { id, job };
}

// Job folders left behind by a crash or an earlier version (they can hold large downloads).
function removeStaleJobs() {
  try {
    const root = dataDir("jobs");
    for (const name of fs().readdirSync(root)) {
      if (!jobs.has(name)) removeDir(path().join(root, name));
    }
  } catch {}
}

function setStatus(job: Job, stage: string, message: string, progress = -1) {
  job.status = { state: "running", stage, progress, message };
}

// Runs a program and resolves with its exit code; stderr lines go to onStderr.
function run(job: Job, exe: string, args: string[], onStderr?: (text: string) => void): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new CancelledError());
    const child = childProcess().spawn(exe, args, { cwd: job.dir, windowsHide: true });
    job.child = child;
    let stderr = "";
    child.stderr?.on("data", (chunk: any) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-8000);
      onStderr?.(text);
    });
    child.stdout?.on("data", () => {});
    child.on("error", (err: Error) => {
      job.child = null;
      reject(err);
    });
    child.on("close", (code: number) => {
      job.child = null;
      if (job.cancelled) reject(new CancelledError());
      else resolve({ code: code ?? 1, stderr });
    });
  });
}

function tail(text: string) {
  return text.trim().split(/\r?\n/).slice(-6).join("\n");
}

async function runOrThrow(job: Job, exe: string, args: string[], what: string, onStderr?: (t: string) => void) {
  const { code, stderr } = await run(job, exe, args, onStderr);
  if (code !== 0) {
    const err: any = new Error(`${what} failed (exit code ${code})`);
    err.logTail = tail(stderr);
    throw err;
  }
}

function finish(job: Job, fn: () => Promise<void>) {
  fn()
    .then(() => {
      job.status = { state: "done", stage: "done", progress: 100, message: "" };
    })
    .catch((e: any) => {
      job.status =
        e instanceof CancelledError || job.cancelled
          ? { state: "cancelled", stage: job.status.stage, progress: -1, message: "Cancelled" }
          : { state: "error", stage: job.status.stage, progress: -1, message: e?.message || String(e), logTail: e?.logTail };
    })
    .then(() => removeDir(job.dir));
}

// Downloads with the system curl (Windows 10+ and macOS have it), reporting progress by file size.
async function download(job: Job, stage: string, url: string, out: string, expected: number, label: string) {
  setStatus(job, stage, `Downloading ${label}`, 0);
  const timer = setInterval(() => {
    let len = 0;
    try {
      len = fs().statSync(out).size;
    } catch {}
    const pct = Math.min(99, Math.floor((100 * len) / expected));
    setStatus(job, stage, `Downloading ${label} (${Math.round(len / 1048576)} MB)`, pct);
  }, 500);
  try {
    const curl = isWin() ? path().join(env().SystemRoot || "C:\\Windows", "System32", "curl.exe") : "/usr/bin/curl";
    const { code, stderr } = await run(job, curl, ["-L", "--fail", "--retry", "3", "-sS", "-o", out, url]);
    if (code !== 0) {
      const err: any = new Error(`Downloading ${label} failed (curl exit code ${code}). Check your internet connection and try again.`);
      err.logTail = tail(stderr);
      throw err;
    }
  } finally {
    clearInterval(timer);
  }
}

async function downloadOnce(job: Job, stage: string, url: string, dest: string, expected: number, label: string) {
  if (fs().existsSync(dest)) return;
  fs().mkdirSync(path().dirname(dest), { recursive: true });
  await download(job, stage, url, dest + ".part", expected, label);
  fs().renameSync(dest + ".part", dest);
}

function findFile(dir: string, name: string): string | null {
  for (const entry of fs().readdirSync(dir, { withFileTypes: true })) {
    const full = path().join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name) {
      return full;
    }
  }
  return null;
}

function copyDir(src: string, dest: string) {
  fs().mkdirSync(dest, { recursive: true });
  for (const entry of fs().readdirSync(src, { withFileTypes: true })) {
    const from = path().join(src, entry.name);
    const to = path().join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs().copyFileSync(from, to);
  }
}

async function unzip(job: Job, zip: string, dest: string) {
  fs().mkdirSync(dest, { recursive: true });
  const tar = path().join(env().SystemRoot || "C:\\Windows", "System32", "tar.exe");
  await runOrThrow(job, tar, ["-xf", zip, "-C", dest], "Unpacking");
}

// Mixes the clips at their timeline positions and transcribes the mix. Only the
// stretch the clips cover is mixed; `job.offset` shifts captions back into place.
async function transcribeClips(
  job: Job,
  p: ReturnType<typeof enginePaths>,
  modelKey: string,
  language: string,
  clips: TimelineAudioClip[],
  duration: number,
  prefix = "",
) {
  const from = Math.max(0, Math.min(...clips.map((c) => c.start)));
  const to = Math.min(duration > 0 ? duration : Infinity, Math.max(...clips.map((c) => c.end)));
  job.offset = from;

  const usable: { n: number; delayMs: number }[] = [];
  for (let n = 0; n < clips.length; n++) {
    setStatus(job, "extract", `${prefix}Extracting audio ${n + 1} of ${clips.length}`);
    const { code } = await run(job, p.ffmpeg, extractArgs(clips[n], n));
    if (code === 0) usable.push({ n, delayMs: Math.round((clips[n].start - from) * 1000) });
    else job.skipped.push(clips[n].name);
  }
  if (usable.length === 0) throw new Error("No usable audio was found on the timeline.");

  fs().writeFileSync(path().join(job.dir, "mix.txt"), mixFilter(usable, to - from));
  setStatus(job, "mix", `${prefix}Mixing audio`);
  await runOrThrow(job, p.ffmpeg, MIX_ARGS, "Mixing timeline audio");
  await runWhisper(job, p, modelKey, language, prefix);
}

async function runWhisper(job: Job, p: ReturnType<typeof enginePaths>, modelKey: string, language: string, prefix = "") {
  setStatus(job, "transcribe", `${prefix}Transcribing speech`, 0);
  const threads = String(Math.max(1, Math.min(8, os().cpus().length)));
  let log = "";
  await runOrThrow(
    job,
    p.whisper,
    [...whisperArgs(p.modelPath(modelKey), language, p.vadModel), "-t", threads],
    "Transcribing speech",
    (text) => {
      log += text;
      const matches = [...text.matchAll(/progress =\s*(\d+)%/g)];
      if (matches.length) setStatus(job, "transcribe", `${prefix}Transcribing speech`, Number(matches[matches.length - 1][1]));
    },
  );
  job.speechSpans = parseSpeechSpans(log);
  job.result = fs().readFileSync(path().join(job.dir, "result.json"), "utf8");
}

function checkReady(status: OfflineEngineStatus, modelKey: string, language: string) {
  if (!OFFLINE_MODELS[modelKey]) throw new Error(`Unknown model "${modelKey}".`);
  if (!isValidLanguage(language)) throw new Error(`Unknown language "${language}".`);
  if (!status.ready || !status.models.includes(modelKey)) {
    throw new Error("The offline engine isn't set up yet for this model. Click the setup button first.");
  }
}

// ---------- public API (same shape as the UXP plugin's) ----------

export async function getOfflineEngineStatus(): Promise<OfflineEngineStatus> {
  if (!hasNode()) {
    return {
      available: false, platform: "win", whisper: false, ffmpeg: false, vad: false, models: [], ready: false, enginePath: "",
      message: "Node.js isn't enabled for this panel, so offline captions can't run.",
    };
  }
  if (jobs.size === 0) removeStaleJobs();
  const p = enginePaths();
  const exists = (f: string) => !!f && fs().existsSync(f);
  const models = Object.keys(OFFLINE_MODELS).filter((k) => exists(p.modelPath(k)));
  const whisper = exists(p.whisper);
  const ffmpeg = exists(p.ffmpeg);
  const vad = exists(p.vadModel);
  return {
    available: true,
    platform: isWin() ? "win" : "mac",
    whisper,
    ffmpeg,
    vad,
    models,
    ready: whisper && ffmpeg && vad && models.length > 0,
    enginePath: p.root,
    message: !isWin() && (!whisper || !ffmpeg) ? "Install the engine with Homebrew first: brew install whisper-cpp ffmpeg" : undefined,
  };
}

export async function startOfflineEngineSetup(modelKey: string) {
  try {
    const model = OFFLINE_MODELS[modelKey];
    if (!model) throw new Error(`Unknown model "${modelKey}".`);
    const p = enginePaths();
    if (!isWin() && (!p.whisper || !p.ffmpeg)) {
      throw new Error("Install the engine with Homebrew first: brew install whisper-cpp ffmpeg");
    }

    const { id, job } = newJob("setup");
    finish(job, async () => {
      const f = fs();
      const pj = path();
      if (isWin() && !f.existsSync(p.whisper)) {
        const zip = pj.join(job.dir, "whisper.zip");
        await download(job, "whisper", WHISPER_WIN_URL, zip, WHISPER_WIN_BYTES, "speech engine");
        setStatus(job, "whisper", "Unpacking speech engine");
        await unzip(job, zip, pj.join(job.dir, "whisper"));
        const cli = findFile(pj.join(job.dir, "whisper"), "whisper-cli.exe");
        if (!cli) throw new Error("whisper-cli.exe was not found in the speech engine download.");
        copyDir(pj.dirname(cli), pj.dirname(p.whisper));
      }
      if (isWin() && !f.existsSync(p.ffmpeg)) {
        const zip = pj.join(job.dir, "ffmpeg.zip");
        await download(job, "ffmpeg", FFMPEG_WIN_URL, zip, FFMPEG_WIN_BYTES, "audio tools (ffmpeg)");
        setStatus(job, "ffmpeg", "Unpacking audio tools");
        await unzip(job, zip, pj.join(job.dir, "ffmpeg"));
        const exe = findFile(pj.join(job.dir, "ffmpeg"), "ffmpeg.exe");
        if (!exe) throw new Error("ffmpeg.exe was not found in the audio tools download.");
        f.mkdirSync(pj.dirname(p.ffmpeg), { recursive: true });
        f.copyFileSync(exe, p.ffmpeg);
      }
      await downloadOnce(job, "vad", VAD_MODEL_URL, p.vadModel, VAD_MODEL_BYTES, "speech detector");
      await downloadOnce(job, "model", MODEL_BASE_URL + model.file, p.modelPath(modelKey), model.bytes, "speech model");
    });
    return { success: true, jobId: id };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

export async function startOfflineTranscription(
  modelKey: string,
  language: string,
  timeline: { clips: TimelineAudioClip[]; skipped: string[]; duration: number },
) {
  try {
    checkReady(await getOfflineEngineStatus(), modelKey, language);
    const { clips, duration } = timeline;
    if (clips.length === 0) {
      throw new Error("No audio clips were found on unmuted audio tracks in this sequence.");
    }

    const p = enginePaths();
    const { id, job } = newJob("transcribe");
    job.skipped = [...timeline.skipped];
    finish(job, () => transcribeClips(job, p, modelKey, language, clips, duration));

    return { success: true, jobId: id, clipCount: clips.length, skipped: timeline.skipped };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

export interface TrackGroup {
  label: string; // speaker name shown on the captions (the track name)
  clips: TimelineAudioClip[];
}

// Transcribes each track on its own (one speaker per track), so overlapping
// voices stay separate and every caption knows who's speaking. A track that
// fails is skipped and reported; the others still finish.
export async function startMultiTrackTranscription(
  modelKey: string,
  language: string,
  groups: TrackGroup[],
  duration: number,
  skipped: string[] = [],
) {
  try {
    checkReady(await getOfflineEngineStatus(), modelKey, language);
    const usable = groups.filter((g) => g.clips.length > 0);
    if (usable.length === 0) throw new Error("None of the chosen tracks has audio clips.");

    const p = enginePaths();
    const { id, job } = newJob("transcribe");
    job.skipped = [...skipped];
    job.trackResults = [];

    finish(job, async () => {
      for (let i = 0; i < usable.length; i++) {
        const group = usable[i];
        const prefix = `Track ${i + 1} of ${usable.length} (${group.label}): `;
        try {
          await transcribeClips(job, p, modelKey, language, group.clips, duration, prefix);
          job.trackResults!.push({ label: group.label, json: job.result!, speechSpans: job.speechSpans, offset: job.offset });
        } catch (e: any) {
          if (e instanceof CancelledError || job.cancelled) throw e;
          job.skipped.push(`${group.label} (${e?.message || e})`);
        }
      }
      if (!job.trackResults!.length) throw new Error("None of the tracks could be transcribed.");
    });

    return { success: true, jobId: id, clipCount: usable.reduce((n, g) => n + g.clips.length, 0), skipped };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

// Captions an audio or video file. `offset` (seconds) shifts the captions so
// they line up where the file sits on the timeline.
export async function startFileTranscription(modelKey: string, language: string, filePath: string, offset: number) {
  try {
    checkReady(await getOfflineEngineStatus(), modelKey, language);
    if (!filePath || !fs().existsSync(filePath)) throw new Error("The selected file couldn't be found.");

    const p = enginePaths();
    const { id, job } = newJob("transcribe");
    // Can be negative when the file is trimmed on the timeline; words before 00:00 are dropped.
    job.offset = offset || 0;

    finish(job, async () => {
      setStatus(job, "extract", `Reading ${path().basename(filePath)}`);
      await runOrThrow(job, p.ffmpeg, fileToWavArgs(filePath), "Reading the audio file");
      await runWhisper(job, p, modelKey, language);
    });
    return { success: true, jobId: id, clipCount: 1, skipped: [] as string[] };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

// Dropped files arrive as browser File objects without a disk path, so they are
// written to the data folder in chunks first.
export async function writeUploadChunk(name: string, chunk: Uint8Array, first: boolean) {
  const safe = name.replace(/[\\/:*?"<>|]/g, "_");
  const dest = path().join(dataDir("uploads"), safe);
  const buf = nodeRequire("buffer").Buffer.from(chunk);
  if (first) fs().writeFileSync(dest, buf);
  else fs().appendFileSync(dest, buf);
  return dest;
}

export async function getOfflineJobStatus(jobId: string): Promise<OfflineJobStatus> {
  const job = jobs.get(jobId);
  return job ? { ...job.status } : { state: "error", stage: "", progress: -1, message: "Job not found." };
}

export async function cancelOfflineJob(jobId: string) {
  const job = jobs.get(jobId);
  if (job) {
    job.cancelled = true;
    try {
      job.child?.kill();
    } catch {}
  }
  return true;
}

export async function readOfflineTranscriptionResult(jobId: string) {
  const job = jobs.get(jobId);
  if (!job?.result) return { success: false, error: "The transcription finished without a result." };
  jobs.delete(jobId);
  removeDir(dataDir("uploads"));
  return {
    success: true,
    json: job.result,
    skipped: job.skipped,
    speechSpans: job.speechSpans,
    offset: job.offset,
    tracks: job.trackResults,
  };
}

// ---------- saved offline transcripts (per sequence) ----------

const transcriptFile = (sequenceId: string) =>
  path().join(dataDir("transcripts"), `${sequenceId.replace(/[^A-Za-z0-9-]/g, "_")}.json`);

export async function saveOfflineTranscript(sequenceId: string, json: string) {
  fs().writeFileSync(transcriptFile(sequenceId), json, "utf8");
  return true;
}

export async function loadOfflineTranscript(sequenceId: string): Promise<string | null> {
  try {
    return fs().readFileSync(transcriptFile(sequenceId), "utf8");
  } catch {
    return null;
  }
}

export async function deleteOfflineTranscript(sequenceId: string) {
  try {
    fs().rmSync(transcriptFile(sequenceId), { force: true });
  } catch {}
  return true;
}
