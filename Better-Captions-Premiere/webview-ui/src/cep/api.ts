// CEP implementation of the host API the panel uses. Premiere access goes
// through ExtendScript (cep/host/index.jsx); files and the offline engine use
// CEP's built-in Node.js.

import * as engine from "./engine";
import { renderOverlayVideo } from "./overlay";
import { decodeFile, decodeTimeline } from "./beats";
import * as luts from "./luts";
import type { TimelineAudioClip } from "../../../src/api/utils/engine-shared";
import type { AnimationConfig, CaptionItem, StyleConfig } from "../lib/types";

const cep = () => (window as any).__adobe_cep__;

export const isCEP = () => !!cep();

const nodeRequire: (id: string) => any =
  (window as any).cep_node?.require ?? (window as any).require;

// Last problem talking to Premiere, shown in the panel instead of a bare "No Active Sequence".
let lastHostError: string | null = null;

function evalRaw(script: string): Promise<string> {
  return new Promise((resolve) => cep().evalScript(script, (result: string) => resolve(result)));
}

// Premiere loads cep/host/index.jsx when the panel opens, but on some systems
// the first calls arrive before it has (or it isn't loaded at all). Load it
// ourselves when its functions are missing.
let hostReady: Promise<void> | null = null;
function ensureHostScript(): Promise<void> {
  if (!hostReady) {
    hostReady = (async () => {
      if ((await evalRaw("typeof bc_getLutTarget")) === "function") return;
      const extensionUrl: string = cep().getSystemPath?.("extension") ?? "";
      const extensionDir = decodeURIComponent(extensionUrl.replace(/^file:\/{2,3}/, ""));
      const script = `${extensionDir.replace(/\/$/, "")}/host/index.jsx`;
      // Wrapped so ExtendScript reports the actual error and line instead of "EvalScript error.".
      const loaded = await evalRaw(
        `(function () { try { $.evalFile(${JSON.stringify(script)}); return typeof bc_getLutTarget; } ` +
          `catch (e) { return "ERROR: " + e.toString() + (e.line ? " (line " + e.line + ")" : ""); } })()`,
      );
      if (loaded !== "function") {
        throw new Error(`Premiere didn't load the extension's script (${script}): ${loaded}`);
      }
    })().catch((e) => {
      hostReady = null; // try again on the next call
      throw e;
    });
  }
  return hostReady;
}

// Calls a bc_* function in index.jsx. Arguments are passed as JSON literals,
// which are valid ExtendScript string/number literals.
async function evalHost<T = any>(fn: string, ...args: (string | number)[]): Promise<T> {
  try {
    await ensureHostScript();
  } catch (e: any) {
    lastHostError = e?.message || String(e);
    throw e;
  }
  const result = await evalRaw(`${fn}(${args.map((a) => JSON.stringify(a)).join(",")})`);
  if (result === "EvalScript error.") {
    lastHostError = `Premiere scripting error in ${fn}.`;
    throw new Error(lastHostError);
  }
  lastHostError = null;
  try {
    return JSON.parse(result);
  } catch {
    return result as any;
  }
}

// <project folder>/Better Captions/<sequence>_captions_<time>.<ext>; a fresh name each
// time so Premiere never confuses a new file with one it already imported.
async function captionsFilePath(sequenceName: string, extension: string) {
  const path = nodeRequire("path");
  const projectPath = await evalHost<string>("bc_getProjectPath");
  if (!projectPath) throw new Error("Save your Premiere project first, so the captions have a folder to go in.");
  const dir = path.join(path.dirname(projectPath), "Better Captions");
  nodeRequire("fs").mkdirSync(dir, { recursive: true });
  const safe = sequenceName.replace(/[\\/:*?"<>|]/g, "_").trim() || "captions";
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return path.join(dir, `${safe}_captions_${stamp}.${extension}`);
}

function hostColors() {
  let bg = { red: 35, green: 35, blue: 35 };
  try {
    const env = JSON.parse(cep().getHostEnvironment());
    bg = env.appSkinInfo.panelBackgroundColor.color;
  } catch {}
  const hex = (r: number, g: number, b: number) =>
    "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const shade = (d: number) => hex(bg.red + d, bg.green + d, bg.blue + d);
  const light = (bg.red + bg.green + bg.blue) / 3 > 128;
  const text = light ? "#222222" : "#ffffff";
  return {
    theme: light ? "light" : "darkest",
    colors: {
      "--uxp-host-background-color": shade(0),
      "--uxp-host-text-color": text,
      "--uxp-host-border-color": shade(light ? -30 : 15),
      "--uxp-host-link-text-color": "#4b9cf5",
      "--uxp-host-widget-hover-background-color": shade(light ? -20 : 20),
      "--uxp-host-widget-hover-text-color": text,
      "--uxp-host-widget-hover-border-color": shade(light ? -20 : 20),
      "--uxp-host-text-color-secondary": light ? "#555555" : "#a0a0a0",
      "--uxp-host-link-hover-text-color": text,
      "--uxp-host-label-text-color": text,
    },
  };
}

export const cepApi = {
  getColorScheme: async () => hostColors(),

  getActiveSequenceId: () => evalHost<string | null>("bc_getActiveSequenceId"),
  getActiveSequenceInfo: async () => {
    const info = await evalHost("bc_getActiveSequenceInfo");
    if (info && info.error) {
      lastHostError = `Couldn't read the active sequence: ${info.error}`;
      return null;
    }
    return info;
  },
  getConnectionError: async () => lastHostError,

  // ExtendScript can't read Premiere's built-in transcript; the CEP extension
  // relies on offline captions instead.
  fetchTranscriptJSON: async () => null,

  getOutputFolder: async (subfolderName?: string) => {
    try {
      const projectPath = await evalHost<string>("bc_getProjectPath");
      if (!projectPath) throw new Error("Save the project first.");
      const path = nodeRequire("path");
      const dir = path.join(path.dirname(projectPath), "Better Captions", subfolderName || "");
      nodeRequire("fs").mkdirSync(dir, { recursive: true });
      return { success: true, path: dir };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },

  saveFrameBatch: async (frames: string[], outputFolderPath: string, startIndex: number, baseName: string) => {
    try {
      const fs = nodeRequire("fs");
      const path = nodeRequire("path");
      if (startIndex === 0) {
        // Clear frames from an earlier, longer export so the image sequence ends where this one does.
        for (const name of fs.readdirSync(outputFolderPath)) {
          if (name.startsWith(`${baseName}_`) && name.endsWith(".png")) fs.rmSync(path.join(outputFolderPath, name));
        }
      }
      frames.forEach((frame, i) => {
        const fileName = `${baseName}_${String(startIndex + i).padStart(6, "0")}.png`;
        fs.writeFileSync(path.join(outputFolderPath, fileName), nodeRequire("buffer").Buffer.from(frame, "base64"));
      });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || "Failed to save frames" };
    }
  },

  importImageSequence: (folderPath: string, frameRate: number, baseName: string) => {
    const path = nodeRequire("path");
    return evalHost("bc_importImageSequence", path.join(folderPath, `${baseName}_000000.png`), baseName, frameRate);
  },

  placeCaptionsOnTimeline: (baseName: string) => evalHost("bc_placeCaptionsOnTimeline", baseName),

  getPlayheadSeconds: () => evalHost<number>("bc_getPlayheadSeconds"),

  // Clips selected (or just copied) in the timeline, with their timeline positions.
  getSelectedClips: () => evalHost("bc_getSelectedClips"),
  // Media selected (or just dragged) in the Project panel; timelineOffset is where
  // the file's 00:00 falls in the active sequence, or null if it isn't used there.
  getProjectSelection: () => evalHost("bc_getProjectSelection"),
  startClipsTranscription: engine.startOfflineTranscription,
  // Audio tracks of the active sequence (name, muted, clip count) plus every clip with its track.
  scanAudioTracks: () => evalHost("bc_getTimelineAudioClips"),
  startMultiTrackTranscription: engine.startMultiTrackTranscription,

  // Beat markers: audio for analysis (timeline clips mixed at their positions, or a file).
  decodeBeatAudio: async (
    source: { kind: "clips"; clips: TimelineAudioClip[] } | { kind: "file"; path: string },
    onStep: (message: string) => void,
  ) => {
    if (source.kind === "file") {
      onStep("Reading audio");
      return { samples: await decodeFile(source.path), offset: 0 };
    }
    return decodeTimeline(source.clips, onStep);
  },
  addBeatMarkers: (target: "sequence" | "clip", itemPath: string, markers: { time: number; bar: number; beat: number }[], bpm: number, beatsPerBar: number) =>
    evalHost("bc_addBeatMarkers", target, itemPath, markers.map((m) => `${m.time.toFixed(4)}:${m.bar}:${m.beat}`).join(","), bpm, beatsPerBar),
  removeBeatMarkers: (target: "sequence" | "clip", itemPath: string) => evalHost("bc_removeBeatMarkers", target, itemPath),

  // LUT Preview.
  scanLutLibrary: luts.scanLutLibrary,
  readLutText: async (file: string) => luts.readLutText(file),
  addLutFolder: async () => luts.addLutFolder(),
  removeLutFolder: async (folder: string) => luts.removeLutFolder(folder),
  loadLutSettings: async () => luts.loadLutSettings(),
  saveLutSettings: async (settings: { folders: string[]; favorites: string[] }) => luts.saveLutSettings(settings),
  revealInFolder: async (file: string) => luts.revealInFolder(file),
  // The frame under the playhead: the clip's own media ("clip", ungraded) or the Program monitor ("program").
  grabFrame: async (source: "clip" | "program") => {
    try {
      if (source === "program") {
        const res = await evalHost("bc_exportProgramFrame", luts.tempFramePath());
        if (!res?.success) throw new Error(res?.error || "Couldn't export the Program frame.");
        const bytes = luts.readFrameFile(res.path);
        try {
          nodeRequire("fs").rmSync(res.path, { force: true });
        } catch {}
        return { success: true, png: bytes, label: "Program monitor" };
      }
      const src = await evalHost("bc_getFrameSource");
      if (!src?.success) throw new Error(src?.error || "Couldn't find the clip under the playhead.");
      return { success: true, png: await luts.frameFromFile(src.path, src.sourceTime), label: src.name };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },
  // LUT on timeline clips (selected clips, or the clip under the playhead).
  getLutTarget: () => evalHost("bc_getLutTarget"),
  setClipLut: (file: string, intensity: number, strategy: number) => evalHost("bc_setClipLut", file, intensity, strategy),
  restoreClipLut: () => evalHost("bc_restoreClipLut"),
  keepClipLut: () => evalHost("bc_keepClipLut"),
  lumetriReport: () => evalHost("bc_lumetriReport"),

  // Native "Open" dialog for an audio/video file (CEP's built-in cep.fs API).
  // Resolves null if the user cancels, undefined if the native dialog isn't available.
  pickMediaFile: async (): Promise<string | null | undefined> => {
    const cepFs = (window as any).cep?.fs;
    if (!cepFs?.showOpenDialogEx) return undefined;
    const types = ["wav", "mp3", "m4a", "aac", "flac", "ogg", "wma", "aif", "aiff", "mp4", "mov", "mkv", "avi", "mxf", "webm"];
    const res = cepFs.showOpenDialogEx(false, false, "Choose an audio or video file", "", types);
    return res && !res.err && res.data && res.data.length ? res.data[0] : null;
  },

  // Native "Save" dialog, then writes the file as UTF-8 (with BOM so non-Latin text opens correctly everywhere).
  saveTextFile: async (defaultName: string, extension: string, content: string) => {
    try {
      const path = nodeRequire("path");
      const projectPath = await evalHost<string>("bc_getProjectPath").catch(() => "");
      const initialDir = projectPath ? path.dirname(projectPath) : "";
      const cepFs = (window as any).cep?.fs;
      let target: string | null = null;
      if (cepFs?.showSaveDialogEx) {
        const res = cepFs.showSaveDialogEx(`Save ${extension.toUpperCase()} file`, initialDir, [extension], defaultName);
        if (res && !res.err && res.data) target = res.data;
      } else {
        target = path.join(initialDir || nodeRequire("os").homedir(), defaultName);
      }
      if (!target) return { success: false, cancelled: true };
      if (!target.toLowerCase().endsWith(`.${extension}`)) target += `.${extension}`;
      nodeRequire("fs").writeFileSync(target, "﻿" + content, "utf8");
      return { success: true, path: target };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },

  importCaptionsToTimeline: (filePath: string) => evalHost("bc_importCaptions", filePath),

  // Renders the styled, animated captions to a transparent video and places it on the timeline.
  addAnimatedCaptions: async (
    captions: CaptionItem[],
    style: StyleConfig,
    animation: AnimationConfig,
    sequenceWidth: number,
    frameRate: number,
    sequenceName: string,
    onProgress: (percent: number) => void,
  ) => {
    try {
      const out = await captionsFilePath(sequenceName, "mov");
      const video = await renderOverlayVideo(captions, style, animation, sequenceWidth, frameRate, out, onProgress);
      const duration = Math.max(...captions.map((c) => c.endTime)) - video.start;
      const placed = await evalHost("bc_placeOverlay", video.path, video.start, duration, style.positionX, style.positionY);
      return placed?.success ? { ...placed, start: video.start, path: video.path } : placed;
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },

  // Adds the captions as an editable Premiere caption track (via an .srt kept next to the project).
  addPremiereCaptions: async (srt: string, sequenceName: string) => {
    try {
      const out = await captionsFilePath(sequenceName, "srt");
      nodeRequire("fs").writeFileSync(out, "﻿" + srt, "utf8");
      return await evalHost("bc_importCaptions", out);
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },

  writeUploadChunk: engine.writeUploadChunk,
  startFileTranscription: engine.startFileTranscription,

  getOfflineEngineStatus: engine.getOfflineEngineStatus,
  startOfflineEngineSetup: engine.startOfflineEngineSetup,
  startOfflineTranscription: async (modelKey: string, language: string) => {
    const timeline = await evalHost("bc_getTimelineAudioClips");
    if (!timeline?.success) return { success: false, error: timeline?.error || "Could not read the timeline." };
    return engine.startOfflineTranscription(modelKey, language, timeline);
  },
  getOfflineJobStatus: engine.getOfflineJobStatus,
  cancelOfflineJob: engine.cancelOfflineJob,
  readOfflineTranscriptionResult: engine.readOfflineTranscriptionResult,
  saveOfflineTranscript: engine.saveOfflineTranscript,
  loadOfflineTranscript: engine.loadOfflineTranscript,
  deleteOfflineTranscript: engine.deleteOfflineTranscript,
};

// CEP has no sequence-changed event for panels, so poll the active sequence.
// The first successful check always reports the state, so a panel whose
// startup call failed (host script still loading) recovers on its own.
export function watchActiveSequence(onActivated: () => void, onClosed: () => void) {
  let last: string | null | undefined;
  const check = async () => {
    try {
      const id = await cepApi.getActiveSequenceId();
      if (id !== last) {
        (id ? onActivated : onClosed)();
        last = id;
      }
    } catch {}
  };
  check();
  setInterval(check, 1500);
}
