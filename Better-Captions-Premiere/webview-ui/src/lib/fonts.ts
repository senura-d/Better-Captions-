// Font list for the style panel, from whichever source the host offers:
// the CEP extension reads installed fonts itself; the UXP webview can use the
// Local Font Access API. Names are kept only if they really render.

import { isCEP } from "../cep/api";
import { addFontFile as cepAddFontFile, listFonts as cepListFonts } from "../cep/fonts";

export const FALLBACK_FONTS = [
  "Arial", "Helvetica", "Inter", "Roboto", "Georgia", "Times New Roman", "Courier New",
  "Verdana", "Impact", "Comic Sans MS", "Montserrat", "Oswald", "Bebas Neue",
];

export interface FontList {
  installed: string[];
  added: string[];
}

let probe: CanvasRenderingContext2D | null = null;
const SAMPLE = "mmmmmmmmmmlli1WWW@#අආ";

// A font is available if text set in it measures differently from every
// generic fallback (an unknown family silently falls back to one of them).
export function fontRenders(family: string): boolean {
  probe ??= document.createElement("canvas").getContext("2d");
  if (!probe) return true;
  const width = (font: string) => {
    probe!.font = `72px ${font}`;
    return probe!.measureText(SAMPLE).width;
  };
  const quoted = `"${family.replace(/"/g, "")}"`;
  return ["monospace", "serif", "sans-serif"].some((generic) => width(`${quoted}, ${generic}`) !== width(generic));
}

let cached: Promise<FontList> | null = null;

export function getFonts(refresh = false): Promise<FontList> {
  if (!cached || refresh) {
    cached = (async () => {
      if (isCEP()) {
        const { installed, added } = await cepListFonts();
        return { installed: installed.filter(fontRenders), added };
      }
      try {
        if ("queryLocalFonts" in window) {
          const fonts = await (window as any).queryLocalFonts();
          const families = [...new Set<string>(fonts.map((f: any) => f.family))].sort((a, b) => a.localeCompare(b));
          if (families.length) return { installed: families, added: [] };
        }
      } catch {}
      return { installed: FALLBACK_FONTS, added: [] };
    })();
  }
  return cached;
}

export const canAddFontFiles = () => isCEP();

export async function addFontFile() {
  const res = await cepAddFontFile();
  if (res.success) cached = null;
  return res;
}
