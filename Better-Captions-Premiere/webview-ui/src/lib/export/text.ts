import type { CaptionItem, TranscriptJSON } from "../types";

// Common subtitle guideline: about 42 characters per line, at most two lines.
const MAX_LINE_CHARS = 42;
const MIN_CAPTION_SECONDS = 0.3;

function srtTime(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

// Splits long captions into two balanced lines at a word boundary.
function wrap(text: string) {
  if (text.length <= MAX_LINE_CHARS) return text;
  const words = text.split(" ");
  let best = text;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const diff = Math.abs(a.length - b.length);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = `${a}\n${b}`;
    }
  }
  return best;
}

// SRT from the captions shown in the panel (so the Max Words setting applies).
// Times are sequence times, so the file lines up when placed at 00:00.
export function captionsToSrt(captions: CaptionItem[]) {
  const sorted = [...captions].sort((a, b) => a.startTime - b.startTime);
  return (
    sorted
      .map((caption, i) => {
        // Only the same speaker's next caption ends this one; other speakers may overlap.
        const next = sorted.slice(i + 1).find((c) => (c.speaker ?? "") === (caption.speaker ?? ""));
        let end = Math.max(caption.endTime, caption.startTime + MIN_CAPTION_SECONDS);
        if (next && end > next.startTime) end = Math.max(caption.startTime + 0.05, next.startTime);
        return `${i + 1}\n${srtTime(caption.startTime)} --> ${srtTime(end)}\n${wrap(caption.text.trim())}\n`;
      })
      .join("\n") + "\n"
  );
}

// Plain transcript: one sentence per line, with the speaker's name when there
// is more than one (multi-track captions).
export function transcriptToTxt(transcript: TranscriptJSON | null, captions: CaptionItem[]) {
  const speakers = new Set((transcript?.segments ?? []).map((s) => s.speaker).filter(Boolean));
  const label = (speaker: string) => (speakers.size > 1 && speaker ? `${speaker}: ` : "");
  const lines = transcript
    ? [...transcript.segments]
        .sort((a, b) => a.start - b.start)
        .map((s) => label(s.speaker) + s.words.map((w) => w.text).join(" ").trim())
    : captions.map((c) => c.text.trim());
  return lines.filter(Boolean).join("\r\n") + "\r\n";
}
