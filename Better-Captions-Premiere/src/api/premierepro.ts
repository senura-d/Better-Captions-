import { premierepro, uxp } from "../globals";
import { asTransaction, lockedTransaction } from "./utils/premierepro-utils";
import { getAddon } from "./utils/addon";
import type {
  Project,
  Sequence,
  ClipProjectItem,
  VideoTrack,
  AudioTrack,
} from "../types/ppro";

const addon = getAddon();

export * from "./offline-engine";

// Asks where to save, then writes UTF-8 text (with BOM so non-Latin captions open correctly everywhere).
export const saveTextFile = async (defaultName: string, extension: string, content: string) => {
  try {
    const file: any = await uxp.storage.localFileSystem.getFileForSaving(defaultName, { types: [extension] });
    if (!file) return { success: false, cancelled: true };
    await file.write("﻿" + content);
    return { success: true, path: file.nativePath as string };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
};

// Imports the caption file into the project; placing it is left to the user in UXP.
export const importCaptionsToTimeline = async (filePath: string) => {
  try {
    const project = await premierepro.Project.getActiveProject();
    const root = await project.getRootItem();
    const ok = await project.importFiles([filePath], true, root as any);
    return ok ? { success: true, placed: false } : { success: false, error: "Premiere couldn't import the caption file." };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
};

export const notify = async (message: string) => {
  alert(message);
};

const PREMIERE_TICKS_PER_SECOND = 254016000000;

export const getActiveSequenceInfo = async () => {
  try {
    const project = await premierepro.Project.getActiveProject();
    if (!project) return null;
    const sequence = await project.getActiveSequence();
    if (!sequence) return null;

    const settings = await sequence.getSettings();
    const frameRect = await settings.getVideoFrameRect();
    const endTime = await sequence.getEndTime();
    const timebase = await sequence.getTimebase();
    const ticksPerFrame = parseInt(timebase);
    const frameRate = ticksPerFrame > 0
      ? PREMIERE_TICKS_PER_SECOND / ticksPerFrame
      : 24;

    console.log("getActiveSequenceInfo", {
      timebase,
      ticksPerFrame,
      frameRate,
      duration: endTime.seconds,
    });

    return {
      id: sequence.guid.toString(),
      name: sequence.name,
      duration: endTime.seconds,
      frameRate: Math.round(frameRate * 100) / 100,
      frameWidth: frameRect.width,
      frameHeight: frameRect.height,
    };
  } catch (e) {
    console.error("getActiveSequenceInfo failed:", e);
    return null;
  }
};

export const fetchTranscriptJSON = async (): Promise<string | null> => {
  try {
    const project = await premierepro.Project.getActiveProject();
    if (!project) return null;
    const sequence = await project.getActiveSequence();
    if (!sequence) return null;

    const seqProjectItem = await sequence.getProjectItem();
    const clipItem = premierepro.ClipProjectItem.cast(seqProjectItem);
    const json = await premierepro.Transcript.exportToJSON(clipItem);

    if (json && json.length > 2) {
      return json;
    }

    return null;
  } catch (e) {
    console.error("fetchTranscriptJSON failed:", e);
    return null;
  }
};

export const checkTranscriptExists = async (): Promise<boolean> => {
  const json = await fetchTranscriptJSON();
  return json !== null;
};

let sequenceActivatedHandler: ((event?: Object) => void) | null = null;
let sequenceClosedHandler: ((event?: Object) => void) | null = null;

export const registerSequenceListeners = async (
  onActivated: () => void,
  onClosed: () => void,
) => {
  try {
    if (sequenceActivatedHandler) {
      premierepro.EventManager.removeGlobalEventListener(
        premierepro.Constants.SequenceEvent.ACTIVATED,
        sequenceActivatedHandler,
      );
    }
    if (sequenceClosedHandler) {
      premierepro.EventManager.removeGlobalEventListener(
        premierepro.Constants.SequenceEvent.CLOSED,
        sequenceClosedHandler,
      );
    }

    sequenceActivatedHandler = () => onActivated();
    sequenceClosedHandler = () => onClosed();

    premierepro.EventManager.addGlobalEventListener(
      premierepro.Constants.SequenceEvent.ACTIVATED,
      sequenceActivatedHandler,
    );
    premierepro.EventManager.addGlobalEventListener(
      premierepro.Constants.SequenceEvent.CLOSED,
      sequenceClosedHandler,
    );
  } catch (e) {
    console.error("registerSequenceListeners failed:", e);
  }
};

export const importFileToProject = async (filePath: string): Promise<boolean> => {
  try {
    const project = await premierepro.Project.getActiveProject();
    return await project.importFiles([filePath], true);
  } catch (e) {
    console.error("importFileToProject failed:", e);
    return false;
  }
};

export const insertOverlayToTimeline = async (
  filePath: string,
  startTimeSeconds: number,
  videoTrackIndex: number,
): Promise<boolean> => {
  try {
    const project = await premierepro.Project.getActiveProject();
    const sequence = await project.getActiveSequence();
    if (!sequence) return false;

    const imported = await project.importFiles([filePath], true);
    if (!imported) return false;

    // Find the imported item
    const root = await project.getRootItem();
    const items = await root.getItems();
    const fileName = filePath.split("/").pop()?.split("\\").pop() || "";
    const importedItem = items.find((item) => item.name.includes(fileName.replace(/\.[^.]+$/, "")));

    if (!importedItem) return false;

    const editor = premierepro.SequenceEditor.getEditor(sequence);
    const time = premierepro.TickTime.createWithSeconds(startTimeSeconds);
    const insertAction = editor.createInsertProjectItemAction(
      importedItem,
      time,
      videoTrackIndex,
      -1,
      false,
    );

    lockedTransaction(project, [insertAction], "Insert Caption Overlay");
    return true;
  } catch (e) {
    console.error("insertOverlayToTimeline failed:", e);
    return false;
  }
};

export const getProjectInfo = async () => {
  const project = await premierepro.Project.getActiveProject();
  return {
    name: project.name,
    path: project.path,
    id: project.guid.toString(),
  };
};

// UXP accepts different file: URL spellings for native paths depending on the
// platform, so try the common forms in turn.
const getEntryByNativePath = async (nativePath: string): Promise<any> => {
  const fs = uxp.storage.localFileSystem;
  const forward = nativePath.replace(/\\/g, "/");
  const candidates = [
    `file:${nativePath}`,
    `file:/${forward.replace(/^\/+/, "")}`,
    `file:///${forward.replace(/^\/+/, "")}`,
  ];
  let lastError: any;
  for (const url of candidates) {
    try {
      return await fs.getEntryWithUrl(url);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
};

const parentDir = (nativePath: string) => nativePath.replace(/[\\/][^\\/]+$/, "");
const pathSep = (nativePath: string) => (nativePath.includes("\\") ? "\\" : "/");

export const saveFrameBatch = async (
  frames: string[],
  outputFolderPath: string,
  startIndex: number,
  baseName: string,
): Promise<{ success: boolean; error?: string }> => {
  try {
    const outputFolder = await getEntryByNativePath(outputFolderPath);

    for (let i = 0; i < frames.length; i++) {
      const frameNum = String(startIndex + i).padStart(6, "0");
      const fileName = `${baseName}_${frameNum}.png`;
      const file = await outputFolder.createFile(fileName, { overwrite: true });

      const binaryStr = atob(frames[i]);
      const bytes = new Uint8Array(binaryStr.length);
      for (let j = 0; j < binaryStr.length; j++) {
        bytes[j] = binaryStr.charCodeAt(j);
      }

      await file.write(bytes.buffer, { format: uxp.storage.formats.binary });
    }

    return { success: true };
  } catch (e: any) {
    console.error("saveFrameBatch failed:", e);
    return { success: false, error: e?.message || "Failed to save frames" };
  }
};

function findFfmpeg(): string | null {
  if (!addon) return null;
  const paths = [
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ];
  for (const p of paths) {
    try {
      const result = addon.execSync(`test -f "${p}" && echo "found"`);
      if (result.trim() === "found") return p;
    } catch {}
  }
  try {
    const result = addon.execSync("which ffmpeg");
    if (result.trim()) return result.trim();
  } catch {}
  return null;
}

export const encodeProRes = async (
  folderName: string,
  frameRate: number,
  outputPath: string,
): Promise<{ success: boolean; error?: string }> => {
  try {
    if (!addon || !addon.execSync) {
      return { success: false, error: "Native addon not available. execSync is required for ProRes encoding." };
    }

    const ffmpeg = findFfmpeg();
    if (!ffmpeg) {
      return { success: false, error: "ffmpeg not found. Install via: brew install ffmpeg" };
    }

    const fs = uxp.storage.localFileSystem;
    const tempFolder = await fs.getTemporaryFolder();
    const outputFolder = await tempFolder.getEntry(folderName);
    const entries = await outputFolder.getEntries();
    const firstPng = entries.find((e: any) => e.name.endsWith("_000000.png"));
    if (!firstPng) {
      return { success: false, error: "No PNG frames found in folder" };
    }
    const framesDir = firstPng.nativePath.replace(/\/[^/]+$/, "");
    const prefix = firstPng.name.replace(/_000000\.png$/, "");

    const inputPattern = `${framesDir}/${prefix}_%06d.png`;
    const cmd = `"${ffmpeg}" -y -framerate ${frameRate} -i "${inputPattern}" -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le "${outputPath}"`;

    console.log("encodeProRes cmd:", cmd);
    const result = addon.execSync(cmd + " 2>&1");
    console.log("ffmpeg output:", result.substring(0, 500));

    const checkExists = addon.execSync(`test -f "${outputPath}" && echo "exists"`);
    if (checkExists.trim() !== "exists") {
      return { success: false, error: "ffmpeg did not produce output file" };
    }

    return { success: true };
  } catch (e: any) {
    console.error("encodeProRes failed:", e);
    return { success: false, error: e?.message || String(e) };
  }
};

export const getOutputFolder = async (
  subfolderName?: string,
): Promise<{ success: boolean; path?: string; error?: string }> => {
  try {
    const project = await premierepro.Project.getActiveProject();
    const projectPath = project.path;
    const projectDir = parentDir(projectPath);

    let baseFolder: any;
    try {
      baseFolder = await getEntryByNativePath(`${projectDir}${pathSep(projectPath)}Better Captions`);
    } catch {
      const parentFolder = await getEntryByNativePath(projectDir);
      baseFolder = await parentFolder.createFolder("Better Captions");
    }

    if (subfolderName) {
      let subFolder: any;
      try {
        subFolder = await baseFolder.getEntry(subfolderName);
      } catch {
        subFolder = await baseFolder.createFolder(subfolderName);
      }
      return { success: true, path: subFolder.nativePath };
    }

    return { success: true, path: baseFolder.nativePath };
  } catch (e: any) {
    console.error("getOutputFolder failed:", e);
    return { success: false, error: e?.message || String(e) };
  }
};

export const importVideoFile = async (
  filePath: string,
): Promise<{ success: boolean; error?: string }> => {
  try {
    const project = await premierepro.Project.getActiveProject();
    const root = await project.getRootItem();
    const imported = await project.importFiles([filePath], true, root);

    if (!imported) {
      return { success: false, error: "Import failed" };
    }

    return { success: true };
  } catch (e: any) {
    console.error("importVideoFile failed:", e);
    return { success: false, error: e?.message || String(e) };
  }
};

const findLatestImportedItem = async (baseName: string) => {
  const project = await premierepro.Project.getActiveProject();
  const root = await project.getRootItem();
  const items = await root.getItems();
  const matches: any[] = items.filter((item: any) => item.name.includes(baseName));
  return matches.length ? matches[matches.length - 1] : null;
};

// Captions are rendered from sequence time 0, so placing the overlay at 0 on
// an empty video track keeps every caption in sync with the timeline audio.
export const placeCaptionsOnTimeline = async (
  baseName: string,
): Promise<{ success: boolean; trackNumber?: number; error?: string }> => {
  try {
    const project = await premierepro.Project.getActiveProject();
    const sequence = await project.getActiveSequence();
    if (!sequence) return { success: false, error: "No active sequence." };

    const item = await findLatestImportedItem(baseName);
    if (!item) return { success: false, error: "Could not find the imported captions in the project." };

    const clipType = (premierepro.Constants as any)?.TrackItemType?.CLIP ?? 1;
    const trackCount = await sequence.getVideoTrackCount();
    let target = -1;
    for (let i = trackCount - 1; i >= 0; i--) {
      const track = await sequence.getVideoTrack(i);
      const items = await track.getTrackItems(clipType, false);
      if (!items || items.length === 0) {
        target = i;
        break;
      }
    }
    if (target < 0) {
      return {
        success: false,
        error: "Captions were imported into the project, but there's no empty video track. Add one above your footage and export again, or drag the captions clip to 00:00 yourself.",
      };
    }

    const editor = premierepro.SequenceEditor.getEditor(sequence);
    const action = editor.createOverwriteItemAction(
      item,
      premierepro.TickTime.createWithSeconds(0),
      target,
      -1,
    );
    await lockedTransaction(project, [action], "Place Better Captions");
    return { success: true, trackNumber: target + 1 };
  } catch (e: any) {
    console.error("placeCaptionsOnTimeline failed:", e);
    return { success: false, error: e?.message || String(e) };
  }
};

export const importImageSequence = async (
  folderPath: string,
  frameRate: number,
  baseName: string,
): Promise<{ success: boolean; error?: string }> => {
  try {
    const outputFolder = await getEntryByNativePath(folderPath);
    const firstFrame = await outputFolder.getEntry(`${baseName}_000000.png`);
    const filePath = firstFrame.nativePath;

    console.log("importImageSequence - filePath:", filePath, "fps:", frameRate);

    const project = await premierepro.Project.getActiveProject();
    const root = await project.getRootItem();
    const imported = await project.importFiles([filePath], true, root, true);

    if (!imported) {
      return { success: false, error: "Import failed" };
    }

    try {
      const importedItem = await findLatestImportedItem(baseName);

      if (importedItem) {
        const clipItem = premierepro.ClipProjectItem.cast(importedItem);
        const interpretation = await clipItem.getFootageInterpretation();
        interpretation.setFrameRate(frameRate);
        const action = clipItem.createSetFootageInterpretationAction(interpretation);
        await lockedTransaction(project, [action], "Set Caption Frame Rate");
        console.log("Set footage frame rate to:", frameRate);
      }
    } catch (fpsErr: any) {
      console.warn("Could not set frame rate interpretation:", fpsErr?.message);
    }

    return { success: true };
  } catch (e: any) {
    console.error("importImageSequence failed:", e);
    return { success: false, error: e?.message || String(e) };
  }
};
