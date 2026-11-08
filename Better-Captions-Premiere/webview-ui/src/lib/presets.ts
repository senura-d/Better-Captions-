// Caption "looks" (style + animation) saved as named presets. They live outside
// any project (the extension's data folder, or the webview's storage for the UXP
// plugin), so they're available in every project, and can be shared as
// .bcpreset files.

import { isCEP } from "../cep/api";
import { dataDir } from "../cep/engine";
import { DEFAULT_ANIMATION, DEFAULT_STYLE, type AnimationConfig, type StyleConfig } from "./types";

export interface CaptionPreset {
  id: string;
  name: string;
  builtIn?: boolean;
  style: Partial<StyleConfig>;
  animation: Partial<AnimationConfig>;
  createdAt?: number;
}

interface PresetFile {
  format: "better-captions-presets";
  version: 1;
  presets: CaptionPreset[];
}

// Max Words belongs to the transcript, not the look, so presets leave it alone.
const NOT_IN_PRESETS: (keyof StyleConfig)[] = ["maxWords"];

const STORAGE_KEY = "bc-presets";

const nodeRequire: (id: string) => any =
  (window as any).cep_node?.require ?? (window as any).require;

const newId = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export function presetFromLook(name: string, style: StyleConfig, animation: AnimationConfig): CaptionPreset {
  const s: Partial<StyleConfig> = { ...style };
  for (const key of NOT_IN_PRESETS) delete s[key];
  return { id: newId(), name: name.trim() || "My preset", style: s, animation: { ...animation }, createdAt: Date.now() };
}

export function lookFromPreset(preset: CaptionPreset) {
  const style = { ...preset.style };
  for (const key of NOT_IN_PRESETS) delete style[key];
  return { style, animation: { ...preset.animation } };
}

const base: Partial<StyleConfig> = {
  fontSize: 120, lineHeight: 1.3, textAlign: "center", maxWidth: 0.8, positionX: 0.5, positionY: 0.85,
  strokeEnabled: false, strokeColor: "#000000", strokeOpacity: 1, strokeWidth: 2,
  shadowEnabled: false, shadowColor: "#000000", shadowOpacity: 0.5, shadowBlur: 6, shadowOffsetX: 0, shadowOffsetY: 3,
  backgroundEnabled: false, backgroundColor: "#000000", backgroundOpacity: 0.6, backgroundPadding: 14, backgroundRadius: 10,
  glowEnabled: false, glowColor: "#FFD700", glowBlur: 24, glowOpacity: 0.85, glowStrength: 2, glowActiveOnly: false,
  textTransform: "none", textColor: "#FFFFFF", fontWeight: 700,
};
const anim: Partial<AnimationConfig> = {
  fadeEnabled: true, fadeMotion: "none", fadeInDuration: 0.15, fadeOutDuration: 0.15, highlightColor: "#FFD700",
};

export const BUILT_IN_PRESETS: CaptionPreset[] = [
  {
    id: "builtin-clean", name: "Clean White", builtIn: true,
    style: { ...base, fontFamily: "Arial", strokeEnabled: true, strokeWidth: 3, shadowEnabled: true },
    animation: { ...anim, preset: "none" },
  },
  {
    id: "builtin-karaoke", name: "Karaoke Gold", builtIn: true,
    style: { ...base, fontFamily: "Arial", backgroundEnabled: true },
    animation: { ...anim, preset: "karaoke", highlightColor: "#FFD700" },
  },
  {
    id: "builtin-bold-pop", name: "Bold Pop", builtIn: true,
    style: { ...base, fontFamily: "Arial Black", fontWeight: 900, fontSize: 130, textTransform: "uppercase", strokeEnabled: true, strokeWidth: 6, shadowEnabled: true },
    animation: { ...anim, preset: "pop" },
  },
  {
    id: "builtin-neon", name: "Neon Glow", builtIn: true,
    style: { ...base, fontFamily: "Segoe UI", fontWeight: 600, glowEnabled: true, glowColor: "#00E5FF", glowBlur: 30, glowStrength: 3 },
    animation: { ...anim, preset: "fade", fadeMotion: "blur", fadeInDuration: 0.25 },
  },
  {
    id: "builtin-box", name: "Highlight Box", builtIn: true,
    style: { ...base, fontFamily: "Segoe UI", fontWeight: 800, shadowEnabled: true },
    animation: { ...anim, preset: "box", highlightColor: "#7C5CFF" },
  },
  {
    id: "builtin-spotlight", name: "Spotlight", builtIn: true,
    style: { ...base, fontFamily: "Arial", fontWeight: 800, textTransform: "uppercase", backgroundEnabled: true, backgroundOpacity: 0.5 },
    animation: { ...anim, preset: "spotlight", highlightColor: "#FFD54F" },
  },
  {
    id: "builtin-subtitle", name: "Soft Subtitle", builtIn: true,
    style: { ...base, fontFamily: "Segoe UI", fontWeight: 400, fontSize: 96, positionY: 0.9, backgroundEnabled: true, backgroundOpacity: 0.75, backgroundRadius: 6 },
    animation: { ...anim, preset: "none", fadeInDuration: 0.2, fadeOutDuration: 0.2 },
  },
  {
    id: "builtin-bouncy", name: "Bouncy", builtIn: true,
    style: { ...base, fontFamily: "Arial Black", fontWeight: 900, textTransform: "uppercase", strokeEnabled: true, strokeWidth: 5 },
    animation: { ...anim, preset: "drop", fadeMotion: "slide" },
  },
];

// ---------- storage ----------

const presetsFile = () => nodeRequire("path").join(dataDir("presets"), "presets.json");

export function loadUserPresets(): CaptionPreset[] {
  try {
    const raw = isCEP()
      ? (() => {
          try {
            return nodeRequire("fs").readFileSync(presetsFile(), "utf8");
          } catch {
            return "";
          }
        })()
      : localStorage.getItem(STORAGE_KEY) || "";
    if (!raw) return [];
    return parsePresets(raw).map((p) => ({ ...p, builtIn: false }));
  } catch (e) {
    console.warn("Couldn't read saved presets:", e);
    return [];
  }
}

export function saveUserPresets(presets: CaptionPreset[]) {
  const json = serializePresets(presets.filter((p) => !p.builtIn));
  if (isCEP()) nodeRequire("fs").writeFileSync(presetsFile(), json, "utf8");
  else localStorage.setItem(STORAGE_KEY, json);
}

// ---------- sharing (.bcpreset files) ----------

export function serializePresets(presets: CaptionPreset[]) {
  const file: PresetFile = {
    format: "better-captions-presets",
    version: 1,
    presets: presets.map(({ builtIn: _b, ...p }) => p),
  };
  return JSON.stringify(file, null, 2);
}

// Accepts a preset file, a single preset, or a plain list. Imported presets get
// fresh ids so they never overwrite existing ones.
export function parsePresets(text: string, freshIds = false): CaptionPreset[] {
  const data = JSON.parse(text.replace(/^﻿/, ""));
  const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.presets) ? data.presets : [data];
  return list
    .filter((p) => p && typeof p === "object" && p.style && typeof p.style === "object")
    .map((p) => ({
      id: freshIds || typeof p.id !== "string" ? newId() : p.id,
      name: String(p.name || "Imported preset").slice(0, 80),
      style: onlyKnown(p.style, DEFAULT_STYLE) as Partial<StyleConfig>,
      animation: onlyKnown(p.animation, DEFAULT_ANIMATION) as Partial<AnimationConfig>,
      createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
    }));
}

// Keeps only settings the panel knows, with the same type as the default
// (a shared file can't inject anything else).
function onlyKnown(values: any, defaults: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!values || typeof values !== "object") return out;
  for (const [key, def] of Object.entries(defaults)) {
    const v = values[key];
    if (v === undefined || typeof v !== typeof def) continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    out[key] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  return out;
}
