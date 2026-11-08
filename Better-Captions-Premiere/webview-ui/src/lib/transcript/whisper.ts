import type { TranscriptJSON, TranscriptSegment, TranscriptWord } from "../types";
import type { SpeechSpan } from "../../../../src/api/utils/engine-shared";

// A pause longer than this starts a new caption segment even without punctuation.
const SEGMENT_GAP_SECONDS = 1.2;
const MIN_WORD_SECONDS = 0.05;
// Slack when deciding whether a time falls inside detected speech.
const SPAN_TOLERANCE = 0.15;
// A phrase repeated this many times in a row is a whisper loop, not speech.
const LOOP_REPEATS = 3;

// Captions whisper is known to invent over music, silence or noise.
const FILLER_PHRASES = new Set([
  "music", "music playing", "upbeat music", "soft music", "dramatic music", "background music",
  "applause", "laughter", "silence", "inaudible", "no speech", "blank audio",
  "thank you for watching", "thanks for watching", "thank you so much for watching",
  "please subscribe", "subscribe to my channel", "like and subscribe",
  "you",
]);

interface WhisperItem {
  offsets?: { from: number; to: number };
  text?: string;
}

export interface WhisperConvertOptions {
  // Speech stretches detected by whisper's VAD (seconds, same timeline as the words).
  speechSpans?: SpeechSpan[];
  // Seconds added to every time, e.g. where a dropped audio file starts on the timeline.
  offset?: number;
  // Speaker name for every segment (multi-track captions use the track name).
  speaker?: string;
}

const isNonSpeech = (text: string) => /^[\[(♪*].*[\])♪*]$/.test(text) || /^\[.*$/.test(text);
const hasLetters = (text: string) => /[\p{L}\p{N}]/u.test(text);
const endsSentence = (text: string) => /[.!?。！？]["')\]]*$/.test(text);
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, "").trim();

// Drops phrases whisper repeats in a loop ("I'm sorry, I'm sorry, I'm sorry...").
function collapseLoops(words: TranscriptWord[]): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  let i = 0;
  while (i < words.length) {
    let skipped = false;
    for (let n = 1; n <= 4 && !skipped; n++) {
      if (i + n * LOOP_REPEATS > words.length) break;
      const phrase = words.slice(i, i + n).map((w) => normalize(w.text)).join(" ");
      let reps = 1;
      while (
        i + (reps + 1) * n <= words.length &&
        words.slice(i + reps * n, i + (reps + 1) * n).map((w) => normalize(w.text)).join(" ") === phrase
      ) {
        reps++;
      }
      if (reps >= LOOP_REPEATS) {
        out.push(...words.slice(i, i + n));
        i += reps * n;
        skipped = true;
      }
    }
    if (!skipped) out.push(words[i++]);
  }
  return out;
}

// Whisper's word times drift into pauses: the first word after music often
// starts seconds early, and the last word before a pause lingers. Trim words to
// a plausible length and move starts that land outside detected speech.
function fixTiming(words: TranscriptWord[], spans: SpeechSpan[]) {
  const inSpeech = (t: number) =>
    spans.some((s) => t >= s.start - SPAN_TOLERANCE && t <= s.end + SPAN_TOLERANCE);

  for (const word of words) {
    let start = word.start;
    let end = word.start + word.duration;
    const letters = word.text.replace(/[^\p{L}\p{N}]/gu, "").length;
    const maxLength = Math.min(1.6, 0.25 + 0.09 * letters);

    if (end - start > maxLength) {
      if (spans.length && inSpeech(start) && !inSpeech(end)) end = start + maxLength;
      else start = end - maxLength;
    }
    if (spans.length && !inSpeech(start)) {
      const next = spans.find((s) => s.start > start && s.start < end);
      if (next) start = next.start;
    }
    word.start = start;
    word.duration = Math.max(MIN_WORD_SECONDS, end - start);
  }

  for (let i = 1; i < words.length; i++) {
    if (words[i].start < words[i - 1].start) words[i].start = words[i - 1].start;
  }
}

// Converts whisper.cpp `-oj -ml 1 -sow` output (one word per item, offsets in
// ms) into the same shape Premiere's transcript uses.
export function whisperToTranscript(raw: string, options: WhisperConvertOptions = {}): TranscriptJSON {
  const parsed = JSON.parse(raw);
  const items: WhisperItem[] = parsed.transcription ?? [];
  const language: string = parsed.result?.language ?? "en";
  const offset = options.offset ?? 0;

  let words: TranscriptWord[] = [];
  for (const item of items) {
    const text = (item.text ?? "").trim();
    if (!text || !item.offsets || isNonSpeech(text)) continue;

    let start = item.offsets.from / 1000;
    const end = item.offsets.to / 1000;
    const prev = words[words.length - 1];

    // Stray punctuation comes through as its own item; attach it to the last word.
    if (!hasLetters(text)) {
      if (prev) {
        prev.text += text;
        prev.duration = Math.max(prev.duration, end - prev.start);
      }
      continue;
    }

    if (prev && start < prev.start) start = prev.start;
    words.push({
      text,
      start,
      duration: Math.max(MIN_WORD_SECONDS, end - start),
      confidence: 1,
      eos: false,
      type: "word",
      tags: [],
    });
  }

  words = collapseLoops(words);
  fixTiming(words, options.speechSpans ?? []);

  const segments: TranscriptSegment[] = [];
  let current: TranscriptWord[] = [];
  const flush = () => {
    if (!current.length) return;
    const text = normalize(current.map((w) => w.text).join(" "));
    if (!FILLER_PHRASES.has(text)) {
      current[current.length - 1].eos = true;
      const first = current[0];
      const last = current[current.length - 1];
      segments.push({
        start: first.start,
        duration: last.start + last.duration - first.start,
        language,
        speaker: options.speaker ?? "",
        words: current,
      });
    }
    current = [];
  };

  words.forEach((word, i) => {
    current.push(word);
    const next = words[i + 1];
    const gap = next ? next.start - (word.start + word.duration) : 0;
    if (endsSentence(word.text) || gap > SEGMENT_GAP_SECONDS) flush();
  });
  flush();

  if (offset) {
    for (const segment of segments) {
      segment.start += offset;
      for (const word of segment.words) word.start += offset;
    }
  }

  // A negative offset (file trimmed on the timeline) can push words before 00:00.
  const visible = segments
    .map((segment) => ({ ...segment, words: segment.words.filter((w) => w.start >= 0) }))
    .filter((segment) => segment.words.length > 0)
    .map((segment) => ({ ...segment, start: segment.words[0].start }));

  return { language, segments: visible, speakers: [] };
}
