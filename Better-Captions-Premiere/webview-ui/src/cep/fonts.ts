// Fonts for the CEP extension. CEP's browser engine predates the Local Font
// Access API, so installed fonts are read from Windows' font registry (machine
// and per-user) or the macOS font folders. Font files the user adds are kept in
// the data folder and loaded with the FontFace API, so they work uninstalled.

import { dataDir } from "./engine";

const nodeRequire: (id: string) => any =
  (window as any).cep_node?.require ?? (window as any).require;

const FONT_FILE = /\.(ttf|otf|ttc|woff2?)$/i;

// Windows names a family by everything except these style words, so "Arial Black"
// and "Segoe UI Light" stay families of their own while "Arial Bold Italic" is Arial.
const STYLE_WORDS = new Set(["regular", "bold", "italic", "oblique"]);

// "Arial Bold Italic (TrueType)" -> ["Arial"];
// "Cambria & Cambria Math (TrueType)" -> ["Cambria", "Cambria Math"].
// Variable fonts register as "Cormorant Garamond Light" but are often known to
// the renderer as "Cormorant Garamond", so both forms are offered; names that
// don't actually render are filtered out in the panel (lib/fonts.ts).
const WEIGHT_WORDS = new Set([
  "thin", "hairline", "extralight", "ultralight", "light", "semilight", "book", "medium",
  "semibold", "demibold", "extrabold", "ultrabold", "black", "heavy",
]);

export function familiesFromRegistryName(name: string): string[] {
  const bare = name.replace(/\s*\((TrueType|OpenType|All res|VGA res|[^)]*)\)\s*$/i, "").trim();
  const out: string[] = [];
  for (const part of bare.split("&")) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    while (words.length > 1 && STYLE_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
    if (!words.length) continue;
    out.push(words.join(" "));
    const base = [...words];
    while (base.length > 1 && WEIGHT_WORDS.has(base[base.length - 1].toLowerCase())) base.pop();
    if (base.length !== words.length) out.push(base.join(" "));
  }
  return out;
}

// Reads the machine and per-user font registry through PowerShell with UTF-8
// output (reg.exe mangles non-ASCII names). Bitmap .fon fonts are skipped.
function windowsFonts(): Promise<string[]> {
  const execFile = nodeRequire("child_process").execFile;
  const root = (window as any).cep_node?.process?.env?.SystemRoot || "C:\\Windows";
  const powershell = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "foreach ($k in 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts') {",
    "  $p = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue",
    "  if ($p) { $p.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $_.Name + [char]9 + $_.Value } }",
    "}",
  ].join("\n");
  return new Promise((resolve) => {
    execFile(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (_err: any, stdout: string) => {
        const names: string[] = [];
        for (const line of (stdout || "").split(/\r?\n/)) {
          const [name, file] = line.split("\t");
          if (!name || /\.(fon|fnt)$/i.test(file || "")) continue;
          names.push(...familiesFromRegistryName(name));
        }
        resolve(names);
      },
    );
  });
}

function macFonts(): string[] {
  const fs = nodeRequire("fs");
  const path = nodeRequire("path");
  const home = nodeRequire("os").homedir();
  const dirs = ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", path.join(home, "Library/Fonts")];
  const names: string[] = [];
  for (const dir of dirs) {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (!FONT_FILE.test(file)) continue;
        // "Montserrat-BoldItalic.ttf" -> "Montserrat"
        const base = file.replace(FONT_FILE, "").split(/[-_]/)[0].replace(/([a-z])([A-Z])/g, "$1 $2");
        names.push(...familiesFromRegistryName(base));
      }
    } catch {}
  }
  return names;
}

// ---------- font files added in the panel ----------

const fontsDir = () => dataDir("fonts");
const familyFromFile = (file: string) => file.replace(FONT_FILE, "");
const loadedCustom = new Set<string>();

async function loadFontFile(filePath: string) {
  const fs = nodeRequire("fs");
  const path = nodeRequire("path");
  const family = familyFromFile(path.basename(filePath));
  if (loadedCustom.has(family)) return family;
  const data: Uint8Array = fs.readFileSync(filePath);
  const face = new FontFace(family, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  await face.load();
  document.fonts.add(face);
  loadedCustom.add(family);
  return family;
}

// Loads every font file previously added (call once when the panel starts).
export async function loadCustomFonts(): Promise<string[]> {
  const fs = nodeRequire("fs");
  const path = nodeRequire("path");
  const families: string[] = [];
  for (const file of fs.readdirSync(fontsDir())) {
    if (!FONT_FILE.test(file)) continue;
    try {
      families.push(await loadFontFile(path.join(fontsDir(), file)));
    } catch (e) {
      console.warn("Couldn't load font file", file, e);
    }
  }
  return families;
}

// Opens a file dialog, copies the chosen font into the library and loads it.
export async function addFontFile(): Promise<{ success: boolean; family?: string; error?: string; cancelled?: boolean }> {
  try {
    const cepFs = (window as any).cep?.fs;
    const res = cepFs?.showOpenDialogEx?.(false, false, "Choose a font file", "", ["ttf", "otf", "ttc", "woff", "woff2"]);
    const picked: string | undefined = res && !res.err && res.data?.[0];
    if (!picked) return { success: false, cancelled: true };
    const fs = nodeRequire("fs");
    const path = nodeRequire("path");
    const dest = path.join(fontsDir(), path.basename(picked));
    fs.copyFileSync(picked, dest);
    return { success: true, family: await loadFontFile(dest) };
  } catch (e: any) {
    return { success: false, error: `That font couldn't be loaded: ${e?.message || e}` };
  }
}

export async function listFonts(): Promise<{ installed: string[]; added: string[] }> {
  const added = await loadCustomFonts().catch(() => [] as string[]);
  let installed: string[] = [];
  try {
    installed = nodeRequire("os").platform() === "win32" ? await windowsFonts() : macFonts();
  } catch {}
  const sort = (list: string[]) =>
    [...new Set(list.filter((n) => n && !n.startsWith("@")))].sort((a, b) => a.localeCompare(b));
  return { installed: sort(installed), added: sort(added) };
}
