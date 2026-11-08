// Beat analysis: tempo and beat times from music-tempo (Beatroot algorithm,
// MIT), plus a confidence score and downbeat (bar start) detection.
import MusicTempo from "music-tempo";

export const BEAT_SAMPLE_RATE = 44100; // music-tempo's defaults assume 44.1 kHz

export type BeatSpacing = "every" | "every2" | "downbeats";

export interface BeatAnalysis {
  bpm: number;
  beats: number[]; // seconds from the start of the analysed audio
  confidence: number; // 0..1, how steady the beat spacing is
  downbeatPhase: number; // which beat (0..beatsPerBar-1) starts each bar
  beatsPerBar: number;
}

export interface BeatMarker {
  time: number;
  bar: number; // 1-based
  beat: number; // 1-based position in the bar
}

// How steady the gaps between beats are: 1 = metronome, 0 = all over the place.
function steadiness(beats: number[]) {
  if (beats.length < 4) return 0;
  const gaps = beats.slice(1).map((b, i) => b - beats[i]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  return Math.max(0, Math.min(1, 1 - (sd / mean) * 4));
}

// Loudness just after each beat, used to guess which beat starts the bar.
function beatEnergy(samples: Float32Array, beats: number[], sampleRate: number) {
  const window = Math.round(sampleRate * 0.06);
  return beats.map((t) => {
    const start = Math.max(0, Math.round(t * sampleRate));
    const end = Math.min(samples.length, start + window);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    return end > start ? sum / (end - start) : 0;
  });
}

export function analyzeBeats(samples: Float32Array, beatsPerBar = 4, sampleRate = BEAT_SAMPLE_RATE): BeatAnalysis {
  if (samples.length < sampleRate * 3) throw new Error("The audio is too short to find a beat (need at least 3 seconds).");
  const mt = new MusicTempo(samples as unknown as number[]);
  const beats: number[] = (mt.beats ?? []).filter((b: number) => Number.isFinite(b) && b >= 0);
  const bpm = Math.round(Number(mt.tempo) * 10) / 10;
  if (!beats.length || !Number.isFinite(bpm)) throw new Error("No steady beat was found in this audio.");

  // The bar starts on the phase whose beats are loudest on average (kick/accent).
  const energy = beatEnergy(samples, beats, sampleRate);
  let downbeatPhase = 0;
  let best = -1;
  for (let phase = 0; phase < beatsPerBar; phase++) {
    let sum = 0;
    let n = 0;
    for (let i = phase; i < beats.length; i += beatsPerBar) {
      sum += energy[i];
      n++;
    }
    if (n && sum / n > best) {
      best = sum / n;
      downbeatPhase = phase;
    }
  }

  return { bpm, beats, confidence: steadiness(beats), downbeatPhase, beatsPerBar };
}

export function confidenceLabel(confidence: number): { label: string; tone: "good" | "ok" | "poor" } {
  if (confidence >= 0.85) return { label: "High: markers should land right on the beat", tone: "good" };
  if (confidence >= 0.6) return { label: "Medium: check a few markers by ear", tone: "ok" };
  return { label: "Low: the tempo varies, markers may drift", tone: "poor" };
}

// Beats to mark, with their bar/beat position, shifted to timeline time by `offset`.
export function beatMarkers(analysis: BeatAnalysis, spacing: BeatSpacing, offset = 0): BeatMarker[] {
  const { beats, beatsPerBar, downbeatPhase } = analysis;
  const out: BeatMarker[] = [];
  beats.forEach((time, i) => {
    const pos = (((i - downbeatPhase) % beatsPerBar) + beatsPerBar) % beatsPerBar; // 0 = downbeat
    if (spacing === "downbeats" && pos !== 0) return;
    if (spacing === "every2" && pos % 2 !== 0) return;
    // Bar 1 starts at the first downbeat; beats before it are a pickup (bar 0).
    const bar = Math.floor((i - downbeatPhase) / beatsPerBar) + 1;
    out.push({ time: time + offset, bar, beat: pos + 1 });
  });
  return out;
}
