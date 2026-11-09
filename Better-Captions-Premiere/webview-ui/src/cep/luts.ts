// LUT library and frames for the LUT Preview tool (CEP extension).

import { dataDir, ffmpegPath } from "./engine";

const nodeRequire: (id: string) => any =
  (window as any).cep_node?.require ?? (window as any).require;

const fs = () => nodeRequire("fs");
const path = () => nodeRequire("path");
const env = (): Record<string, string | undefined> =>
  ((window as any).cep_node?.process ?? (globalThis as any).process)?.env ?? {};

export interface LutFile {
  name: string; // file name without .cube
  path: string;
  folder: string; // folder path relative to its root ("" for the root itself)
}

export interface LutRoot {
  id: string;
  label: string;
  path: string;
  custom: boolean;
  luts: LutFile[];
}

const settingsFile = () => path().join(dataDir("luts"), "settings.json");

interface LutSettings {
  folders: string[];
  favorites: string[];
}

export function loadLutSettings(): LutSettings {
  try {
    const s = JSON.parse(fs().readFileSync(settingsFile(), "utf8"));
    return { folders: Array.isArray(s.folders) ? s.folders : [], favorites: Array.isArray(s.favorites) ? s.favorites : [] };
  } catch {
    return { folders: [], favorites: [] };
  }
}

export function saveLutSettings(settings: LutSettings) {
  fs().writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
}

// Premiere's own LUTs (newest installed version), Adobe's shared LUT folder,
// the per-user Adobe LUT folder, then folders added in the panel.
function rootCandidates(): { label: string; path: string; custom: boolean }[] {
  const out: { label: string; path: string; custom: boolean }[] = [];
  const isWin = nodeRequire("os").platform() === "win32";
  if (isWin) {
    const programFiles = env().ProgramW6432 || env().ProgramFiles || "C:\\Program Files";
    try {
      const adobe = path().join(programFiles, "Adobe");
      const versions = fs()
        .readdirSync(adobe)
        .filter((d: string) => d.startsWith("Adobe Premiere Pro"))
        .sort()
        .reverse();
      for (const v of versions) {
        const p = path().join(adobe, v, "Lumetri", "LUTs");
        if (fs().existsSync(p)) {
          out.push({ label: "Premiere Pro", path: p, custom: false });
          break;
        }
      }
    } catch {}
    out.push({ label: "Adobe shared", path: path().join(programFiles, "Adobe", "Common", "LUTs"), custom: false });
    if (env().APPDATA) out.push({ label: "My Adobe LUTs", path: path().join(env().APPDATA!, "Adobe", "Common", "LUTs"), custom: false });
  } else {
    out.push({ label: "Premiere Pro", path: "/Library/Application Support/Adobe/Common/LUTs", custom: false });
    out.push({ label: "My Adobe LUTs", path: path().join(nodeRequire("os").homedir(), "Library/Application Support/Adobe/Common/LUTs"), custom: false });
  }
  for (const folder of loadLutSettings().folders) out.push({ label: path().basename(folder) || folder, path: folder, custom: true });
  return out;
}

function scanFolder(root: string, rel = "", out: LutFile[] = [], depth = 0): LutFile[] {
  if (depth > 8) return out;
  let entries: any[] = [];
  try {
    entries = fs().readdirSync(path().join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    // Skip macOS metadata files and folders that ship inside many LUT packs.
    if (e.name.startsWith("._") || e.name === "__MACOSX" || e.name.startsWith(".")) continue;
    const childRel = rel ? path().join(rel, e.name) : e.name;
    if (e.isDirectory()) scanFolder(root, childRel, out, depth + 1);
    else if (/\.cube$/i.test(e.name)) {
      out.push({ name: e.name.replace(/\.cube$/i, ""), path: path().join(root, childRel), folder: rel });
    }
  }
  return out;
}

export async function scanLutLibrary(): Promise<LutRoot[]> {
  const roots: LutRoot[] = [];
  const seen = new Set<string>();
  for (const r of rootCandidates()) {
    const key = r.path.toLowerCase();
    if (seen.has(key) || !fs().existsSync(r.path)) continue;
    seen.add(key);
    const luts = scanFolder(r.path).sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    roots.push({ id: key, label: r.label, path: r.path, custom: r.custom, luts });
    await new Promise((res) => setTimeout(res, 0));
  }
  return roots;
}

export function readLutText(file: string): string {
  return fs().readFileSync(file, "utf8");
}

export function addLutFolder(): { success: boolean; cancelled?: boolean; folder?: string } {
  const cepFs = (window as any).cep?.fs;
  const res = cepFs?.showOpenDialogEx?.(false, true, "Choose a folder of LUTs", "", []);
  const folder: string | undefined = res && !res.err && res.data?.[0];
  if (!folder) return { success: false, cancelled: true };
  const settings = loadLutSettings();
  if (!settings.folders.includes(folder)) settings.folders.push(folder);
  saveLutSettings(settings);
  return { success: true, folder };
}

export function removeLutFolder(folder: string) {
  const settings = loadLutSettings();
  settings.folders = settings.folders.filter((f) => f !== folder);
  saveLutSettings(settings);
}

export function revealInFolder(file: string) {
  if (nodeRequire("os").platform() === "win32") {
    nodeRequire("child_process").execFile(`${env().SystemRoot || "C:\\Windows"}\\explorer.exe`, [`/select,${file}`], () => {});
  } else {
    nodeRequire("child_process").execFile("/usr/bin/open", ["-R", file], () => {});
  }
}

// ---------- frames ----------

const STILL = /\.(png|jpe?g|tiff?|bmp|gif|psd|exr|dpx|webp)$/i;

function ffmpegPng(args: string[]): Promise<Uint8Array> {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg || !fs().existsSync(ffmpeg)) {
    return Promise.reject(new Error("ffmpeg isn't installed yet. Set up the offline engine in Captions first."));
  }
  return new Promise((resolve, reject) => {
    const child = nodeRequire("child_process").spawn(ffmpeg, args, { windowsHide: true });
    const chunks: any[] = [];
    let stderr = "";
    child.stdout.on("data", (d: any) => chunks.push(d));
    child.stderr.on("data", (d: any) => (stderr = (stderr + d.toString()).slice(-1500)));
    child.on("error", reject);
    child.on("close", (code: number) => {
      const buf = nodeRequire("buffer").Buffer.concat(chunks);
      if (code !== 0 || !buf.length) return reject(new Error(`Couldn't read a frame: ${stderr.trim().split(/\r?\n/).pop() || `exit code ${code}`}`));
      resolve(new Uint8Array(buf));
    });
  });
}

// A frame from a media file at `seconds`, as PNG bytes, at most `width` wide.
export function frameFromFile(file: string, seconds: number, width = 960): Promise<Uint8Array> {
  const seek = STILL.test(file) ? [] : ["-ss", Math.max(0, seconds).toFixed(3)];
  return ffmpegPng(["-nostdin", "-v", "error", ...seek, "-i", file, "-frames:v", "1",
    "-vf", `scale='min(${width},iw)':-2`, "-f", "image2pipe", "-vcodec", "png", "pipe:1"]);
}

export function readFrameFile(file: string): Uint8Array {
  return new Uint8Array(fs().readFileSync(file));
}

export const tempFramePath = () => path().join(dataDir("luts"), `program-frame-${Date.now()}.png`);

// ---------- Premiere's Look menu ----------
// Lumetri's Creative > Look menu lists the LUTs Premiere finds in its Creative
// folders when it starts. A script can choose an entry in that menu but can't
// load any other LUT file, so LUTs are added to the per-user Creative folder
// (no admin rights needed) and show up after Premiere restarts.

export function creativeFolders(): string[] {
  const out: string[] = [];
  const isWin = nodeRequire("os").platform() === "win32";
  if (isWin) {
    const programFiles = env().ProgramW6432 || env().ProgramFiles || "C:\Program Files";
    for (const r of rootCandidates()) if (!r.custom && r.label === "Premiere Pro") out.push(path().join(r.path, "Creative"));
    out.push(path().join(programFiles, "Adobe", "Common", "LUTs", "Creative"));
  } else {
    out.push("/Library/Application Support/Adobe/Common/LUTs/Creative");
  }
  out.push(userCreativeFolder());
  return out;
}

export function userCreativeFolder() {
  return nodeRequire("os").platform() === "win32"
    ? path().join(env().APPDATA || "", "Adobe", "Common", "LUTs", "Creative")
    : path().join(nodeRequire("os").homedir(), "Library/Application Support/Adobe/Common/LUTs/Creative");
}

const norm = (p: string) => p.split("\\").join("/").toLowerCase();

// True when the file sits in one of Premiere's Creative folders.
export function inCreativeFolder(file: string) {
  const f = norm(file);
  return creativeFolders().some((dir) => f.startsWith(norm(dir) + "/"));
}

// Every LUT in the Creative folders, sorted by name, the order Premiere's Look
// menu most likely uses (a guess the panel checks against the picture).
export function listCreativeLuts(): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: any[] = [];
    try {
      entries = fs().readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.startsWith("._")) continue;
      const full = path().join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(cube|look|itx|3dl|lut|csp)$/i.test(e.name)) files.push(full);
    }
  };
  for (const d of creativeFolders()) walk(d, 0);
  const base = (p: string) => path().basename(p).replace(/\.[^.]+$/, "").toLowerCase();
  return files.sort((a, b) => base(a).localeCompare(base(b), undefined, { numeric: true }));
}

// Copies a LUT into the per-user Creative folder (once). Returns the copy's path.
export function addToLookMenu(file: string): string {
  const dir = userCreativeFolder();
  fs().mkdirSync(dir, { recursive: true });
  const dest = path().join(dir, path().basename(file));
  if (!fs().existsSync(dest)) fs().copyFileSync(file, dest);
  return dest;
}

export const sameLutFile = (a: string, b: string) =>
  norm(a) === norm(b) || norm(path().basename(a)) === norm(path().basename(b));
