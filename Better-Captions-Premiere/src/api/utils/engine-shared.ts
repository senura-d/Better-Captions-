// Pieces of the offline captioning engine shared by the UXP plugin
// (src/api/offline-engine.ts) and the CEP extension (webview-ui/src/cep).
// Pure data and argument building only: no host APIs here.

export const WHISPER_WIN_URL =
  "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip";
export const WHISPER_WIN_BYTES = 8194445;
export const FFMPEG_WIN_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
export const FFMPEG_WIN_BYTES = 114768076;
export const MODEL_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
export const MAC_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

// Silero voice-activity model: whisper only transcribes stretches with speech,
// which stops it inventing text ("Music playing", "I'm sorry, I'm sorry...")
// over music and silence. Timestamps still come back on the original timeline.
export const VAD_MODEL_FILE = "ggml-silero-v5.1.2.bin";
export const VAD_MODEL_URL = "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin";
export const VAD_MODEL_BYTES = 885098;

// Keeps the speech band and evens out levels so quiet dialogue under music is audible to whisper.
export const VOICE_BOOST_FILTER = "highpass=f=80,lowpass=f=8000,dynaudnorm=f=150:g=15";

// Captions use one speech model: Large v3 Turbo (quantised), accurate across
// languages and noisy audio. The installer downloads it with the engine.
export const CAPTION_MODEL = "large-v3-turbo-q5_0";

export const OFFLINE_MODELS: Record<string, { file: string; bytes: number; label: string }> = {
  [CAPTION_MODEL]: {
    file: "ggml-large-v3-turbo-q5_0.bin",
    bytes: 574041195,
    label: "Large v3 Turbo",
  },
};

export interface OfflineEngineStatus {
  available: boolean;
  platform: "win" | "mac";
  whisper: boolean;
  ffmpeg: boolean;
  vad: boolean;
  models: string[];
  ready: boolean;
  enginePath: string;
  message?: string;
}

export interface OfflineJobStatus {
  state: "starting" | "running" | "done" | "error" | "cancelled";
  stage: string;
  progress: number;
  message: string;
  logTail?: string;
}

export interface TimelineAudioClip {
  name: string;
  path: string;
  start: number;
  end: number;
  sourceIn: number;
  sourceDuration: number;
  speed: number;
  reversed: boolean;
  track?: number; // audio track index (0 = A1), when known
}

export const isValidLanguage = (language: string) => /^(auto|[a-z]{2,3})$/.test(language);

function audioFilterFor(clip: TimelineAudioClip) {
  const filters: string[] = [];
  if (clip.reversed) filters.push("areverse");
  let s = clip.speed;
  if (Math.abs(s - 1) > 0.001) {
    while (s > 2) {
      filters.push("atempo=2");
      s /= 2;
    }
    while (s < 0.5) {
      filters.push("atempo=0.5");
      s /= 0.5;
    }
    filters.push(`atempo=${s.toFixed(4)}`);
  }
  return filters.join(",");
}

// Extracts one clip's used range as 16 kHz mono, retimed to its timeline speed.
export function extractArgs(clip: TimelineAudioClip, n: number) {
  const af = audioFilterFor(clip);
  return [
    "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
    "-ss", clip.sourceIn.toFixed(3),
    "-t", clip.sourceDuration.toFixed(3),
    "-i", clip.path,
    "-vn", "-ac", "1", "-ar", "16000",
    ...(af ? ["-af", af] : []),
    "-c:a", "pcm_s16le",
    `c${n}.wav`,
  ];
}

// Places each extracted clip at its timeline start and pads to the sequence length,
// so whisper's timestamps are sequence times.
export function mixFilter(clips: { n: number; delayMs: number }[], duration: number) {
  const d = duration.toFixed(3);
  const parts = clips.map((c, k) => `amovie=c${c.n}.wav,adelay=${c.delayMs}:all=1[a${k}]`);
  const labels = clips.map((_, k) => `[a${k}]`).join("");
  return `${parts.join(";")};${labels}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad=whole_dur=${d},atrim=end=${d},${VOICE_BOOST_FILTER}[out]`;
}

// Converts a whole audio/video file to whisper's input format (for "Audio file" mode).
export const fileToWavArgs = (inputPath: string) => [
  "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
  "-i", inputPath,
  "-vn", "-af", VOICE_BOOST_FILTER, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "mix.wav",
];

export const MIX_ARGS = [
  "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
  "-/filter_complex", "mix.txt",
  "-map", "[out]", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "mix.wav",
];

// Beam search (-bs/-bo) is noticeably more accurate than greedy decoding on real-world audio.
export const whisperArgs = (model: string, language: string, vadModel?: string) => [
  "-m", model, "-f", "mix.wav", "-l", language,
  "-oj", "-of", "result", "-ml", "1", "-sow", "-sns", "-pp",
  "-bs", "5", "-bo", "5",
  ...(vadModel ? ["--vad", "-vm", vadModel] : []),
];

export interface SpeechSpan {
  start: number;
  end: number;
}

// whisper.cpp logs each detected speech stretch on stderr, e.g.
// "vad_segment_info: orig_start: 3.14, orig_end: 4.25, vad_start: ...".
export function parseSpeechSpans(log: string): SpeechSpan[] {
  const spans: SpeechSpan[] = [];
  const re = /orig_start:\s*([\d.]+),\s*orig_end:\s*([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log))) spans.push({ start: Number(m[1]), end: Number(m[2]) });
  return spans;
}
