import type { TranscriptJSON } from "../types";

// Caption colours offered to speakers in order (multi-track captions).
export const SPEAKER_COLORS = ["#FFFFFF", "#FFD54F", "#4FC3F7", "#AED581", "#F48FB1", "#FFB74D", "#B39DDB", "#80CBC4"];

export interface TrackTranscript {
  label: string;
  transcript: TranscriptJSON;
  color?: string;
}

// Combines one transcript per audio track into a single, time-ordered
// transcript. Each track's name becomes its speaker, optionally with a colour.
export function mergeTrackTranscripts(parts: TrackTranscript[]): TranscriptJSON {
  const segments = parts
    .flatMap((p) => p.transcript.segments.map((s) => ({ ...s, speaker: p.label })))
    .sort((a, b) => a.start - b.start);
  return {
    language: parts.find((p) => p.transcript.segments.length)?.transcript.language ?? "en",
    segments,
    speakers: parts.map((p) => ({ id: p.label, name: p.label, ...(p.color ? { color: p.color } : {}) })),
  };
}
