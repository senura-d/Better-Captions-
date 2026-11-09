<script lang="ts">
  import SectionHeader from "./SectionHeader.svelte";
  import AudioLines from "@lucide/svelte/icons/audio-lines";
  import { onDestroy } from "svelte";
  import type { TranscriptJSON, TranscriptSource } from "../lib/types";
  import { whisperToTranscript } from "../lib/transcript/whisper";
  import { mergeTrackTranscripts, SPEAKER_COLORS } from "../lib/transcript/merge";
  import { formatTime } from "../lib/transcript/parser";
  import { CAPTION_MODEL } from "../../../src/api/utils/engine-shared";

  interface Props {
    hostApi: any;
    sequenceId: string;
    transcriptSource: TranscriptSource | null;
    onGenerated: (sequenceId: string, transcript: TranscriptJSON) => void;
    onUsePremiere: () => void;
    canUsePremiereTranscript?: boolean;
    // Captioning a chosen/dropped file needs disk access (the CEP extension has it).
    canUseFiles?: boolean;
  }

  let {
    hostApi,
    sequenceId,
    transcriptSource,
    onGenerated,
    onUsePremiere,
    canUsePremiereTranscript = true,
    canUseFiles = false,
  }: Props = $props();

  interface EngineStatus {
    available: boolean;
    platform: "win" | "mac";
    whisper: boolean;
    ffmpeg: boolean;
    vad: boolean;
    models: string[];
    ready: boolean;
    message?: string;
  }

  interface JobStatus {
    state: "starting" | "running" | "done" | "error" | "cancelled";
    stage: string;
    progress: number;
    message: string;
    logTail?: string;
  }

  const languages = [
    { value: "auto", label: "Detect automatically" },
    { value: "en", label: "English" },
    { value: "si", label: "Sinhala" },
    { value: "ta", label: "Tamil" },
    { value: "hi", label: "Hindi" },
    { value: "es", label: "Spanish" },
    { value: "fr", label: "French" },
    { value: "de", label: "German" },
    { value: "pt", label: "Portuguese" },
    { value: "it", label: "Italian" },
    { value: "nl", label: "Dutch" },
    { value: "ru", label: "Russian" },
    { value: "ar", label: "Arabic" },
    { value: "ja", label: "Japanese" },
    { value: "ko", label: "Korean" },
    { value: "zh", label: "Chinese" },
  ];

  // Dropped files are copied to disk in pieces this size.
  const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

  const readPref = (key: string, fallback: string) => {
    try {
      return localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  };
  const writePref = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {}
  };

  let isOpen = $state(true);
  let engine = $state<EngineStatus | null>(null);
  // Captions always use Large v3 Turbo; the installer downloads it with the engine.
  const model = CAPTION_MODEL;
  let language = $state(readPref("bc-offline-language", "auto"));
  type Source = "timeline" | "selection" | "file";
  interface ClipSet {
    clips: { name: string; start: number; end: number }[];
    skipped: string[];
    duration: number;
  }

  let source = $state<Source>("timeline");
  let file = $state<{ name: string; path: string } | null>(null);
  let fileOffset = $state(0);
  let fileOffsetNote = $state<string | null>(null);
  let selection = $state<ClipSet | null>(null);
  let lastPasteAt = 0;

  // Multi-track scanning (Whole timeline mode).
  interface TrackInfo {
    index: number;
    name: string;
    muted: boolean;
    clipCount: number;
  }
  interface TrackScan {
    tracks: TrackInfo[];
    clips: { track?: number; name: string; start: number; end: number }[];
    skipped: string[];
    duration: number;
  }
  let trackScan = $state<TrackScan | null>(null);
  let trackChecked = $state<Record<number, boolean>>({});
  let separateTracks = $state(true);
  let colorBySpeaker = $state(readPref("bc-color-speakers", "1") === "1");
  let trackColors = $state<Record<string, string>>({});
  let scanning = $state(false);

  async function scanTracks() {
    scanning = true;
    error = null;
    try {
      const res = await hostApi.scanAudioTracks();
      if (!res?.success) throw new Error(res?.error || "Couldn't read the audio tracks.");
      trackScan = res;
      const usable = res.tracks.filter((t: TrackInfo) => !t.muted && t.clipCount > 0);
      trackChecked = Object.fromEntries(res.tracks.map((t: TrackInfo) => [t.index, !t.muted && t.clipCount > 0]));
      separateTracks = usable.length > 1;
      trackColors = Object.fromEntries(
        res.tracks.map((t: TrackInfo, i: number) => [t.name, trackColors[t.name] ?? SPEAKER_COLORS[i % SPEAKER_COLORS.length]]),
      );
    } catch (e: any) {
      error = e?.message || String(e);
    } finally {
      scanning = false;
    }
  }
  let dragging = $state(false);
  let preparing = $state<string | null>(null);
  let job = $state<{ id: string; kind: "setup" | "transcribe"; sequenceId: string; label: string } | null>(null);
  let jobStatus = $state<JobStatus | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;
  let fileInput: HTMLInputElement | undefined = $state();

  let modelInstalled = $derived(!!engine?.models.includes(model));
  let busy = $derived(job !== null || preparing !== null);
  let onlyDetectorMissing = $derived(
    !!engine && engine.whisper && engine.ffmpeg && engine.models.length > 0 && !engine.vad,
  );

  refreshEngine();

  async function refreshEngine() {
    try {
      engine = await hostApi.getOfflineEngineStatus();
    } catch (e: any) {
      error = e?.message || "Could not check the offline engine.";
    }
  }

  function startPolling() {
    stopPolling();
    timer = setInterval(poll, 700);
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  onDestroy(stopPolling);

  async function poll() {
    if (!job) return stopPolling();
    const current = job;
    let status: JobStatus;
    try {
      status = await hostApi.getOfflineJobStatus(current.id);
    } catch {
      return;
    }
    jobStatus = status;

    if (status.state === "done") {
      stopPolling();
      if (current.kind === "setup") {
        await refreshEngine();
        notice = "Offline engine is ready. Everything now runs on this computer.";
      } else {
        await finishTranscription(current.id, current.sequenceId, current.label);
      }
      job = null;
    } else if (status.state === "error" || status.state === "cancelled") {
      stopPolling();
      if (status.state === "error") {
        error = [status.message || "Something went wrong.", status.logTail].filter(Boolean).join("\n");
      }
      job = null;
    }
  }

  async function finishTranscription(jobId: string, jobSequenceId: string, label: string) {
    const result = await hostApi.readOfflineTranscriptionResult(jobId);
    if (!result?.success) {
      error = result?.error || "Could not read the transcription.";
      return;
    }
    // Multi-track jobs return one transcription per track: convert each with its
    // track as the speaker, then merge them in time order.
    const transcript = result.tracks?.length
      ? mergeTrackTranscripts(
          result.tracks.map((t: any) => ({
            label: t.label,
            transcript: whisperToTranscript(t.json, { speechSpans: t.speechSpans, offset: t.offset, speaker: t.label }),
            color: colorBySpeaker ? trackColors[t.label] : undefined,
          })),
        )
      : whisperToTranscript(result.json, {
          speechSpans: result.speechSpans,
          offset: result.offset,
        });
    const wordCount = transcript.segments.reduce((n, s) => n + s.words.length, 0);
    if (wordCount === 0) {
      error = `No speech was found in ${label}. If someone is talking, check the Language setting and try Large v3 Turbo.`;
      return;
    }
    await hostApi.saveOfflineTranscript(jobSequenceId, JSON.stringify(transcript));
    onGenerated(jobSequenceId, transcript);
    notice = `Generated ${wordCount} words from ${label}.`;
    if (result.skipped?.length) notice += ` Skipped: ${result.skipped.join(", ")}.`;
  }

  async function runSetup() {
    error = null;
    notice = null;
    const res = await hostApi.startOfflineEngineSetup(model);
    if (!res?.success) {
      error = res?.error || "Could not start the download.";
      return;
    }
    job = { id: res.jobId, kind: "setup", sequenceId, label: "" };
    jobStatus = { state: "starting", stage: "", progress: -1, message: "Starting download…" };
    startPolling();
  }

  async function runTranscription() {
    error = null;
    notice = null;
    writePref("bc-offline-language", language);

    let res: any;
    let label: string;
    if (source === "file") {
      if (!file) return;
      label = file.name;
      res = await hostApi.startFileTranscription(model, language, file.path, Number(fileOffset) || 0);
    } else if (source === "selection") {
      if (!selection?.clips.length) return;
      label = selection.clips.length === 1 ? selection.clips[0].name : `${selection.clips.length} selected clips`;
      res = await hostApi.startClipsTranscription(model, language, $state.snapshot(selection));
    } else if (trackScan && canUseFiles) {
      // Tracks were scanned: use only the ticked ones, separately or mixed.
      const picked = trackScan.tracks.filter((t) => trackChecked[t.index] && t.clipCount > 0);
      if (!picked.length) {
        error = "Tick at least one audio track that has clips.";
        return;
      }
      const clipsOf = (index: number) => trackScan!.clips.filter((c) => c.track === index);
      if (separateTracks && picked.length > 1) {
        label = `${picked.length} audio tracks`;
        res = await hostApi.startMultiTrackTranscription(
          model,
          language,
          picked.map((t) => ({ label: t.name, clips: $state.snapshot(clipsOf(t.index)) })),
          trackScan.duration,
          $state.snapshot(trackScan.skipped),
        );
      } else {
        label = picked.length === 1 ? picked[0].name : `${picked.length} audio tracks (mixed)`;
        res = await hostApi.startClipsTranscription(model, language, {
          clips: $state.snapshot(picked.flatMap((t) => clipsOf(t.index))),
          skipped: $state.snapshot(trackScan.skipped),
          duration: trackScan.duration,
        });
      }
    } else {
      label = "the timeline audio";
      res = await hostApi.startOfflineTranscription(model, language);
    }
    if (!res?.success) {
      error = res?.error || "Could not start transcription.";
      return;
    }
    if (res.skipped?.length) notice = `Skipped: ${res.skipped.join(", ")}.`;
    job = { id: res.jobId, kind: "transcribe", sequenceId, label };
    jobStatus = {
      state: "starting",
      stage: "",
      progress: -1,
      message: source === "file" ? `Reading ${label}…` : `Preparing ${res.clipCount} audio clip(s)…`,
    };
    startPolling();
  }

  async function cancel() {
    if (job) await hostApi.cancelOfflineJob(job.id);
  }

  async function usePremiere() {
    await hostApi.deleteOfflineTranscript(sequenceId);
    notice = null;
    onUsePremiere();
  }

  async function chooseFile() {
    error = null;
    const picked: string | null | undefined = await hostApi.pickMediaFile?.();
    if (picked) setFile(picked.split(/[\\/]/).pop() || picked, picked, null);
    else if (picked === undefined) fileInput?.click();
  }

  // Browser File objects don't carry a disk path here, so copy the file to disk first.
  async function useBrowserFile(f: File) {
    error = null;
    fileOffset = 0;
    fileOffsetNote = null;
    const known = (f as any).path as string | undefined;
    if (known) {
      file = { name: f.name, path: known };
      return;
    }
    try {
      let dest = "";
      for (let pos = 0; pos < f.size || pos === 0; pos += UPLOAD_CHUNK_BYTES) {
        preparing = `Preparing ${f.name}… ${f.size ? Math.round((100 * pos) / f.size) : 0}%`;
        const chunk = new Uint8Array(await f.slice(pos, pos + UPLOAD_CHUNK_BYTES).arrayBuffer());
        dest = await hostApi.writeUploadChunk(f.name, chunk, pos === 0);
        if (f.size === 0) break;
      }
      file = { name: f.name, path: dest };
    } catch (e: any) {
      error = `Couldn't read ${f.name}: ${e?.message || e}`;
    } finally {
      preparing = null;
    }
  }

  function setFile(name: string, path: string, offset: number | null) {
    file = { name, path };
    source = "file";
    if (offset !== null && offset !== undefined) {
      fileOffset = Math.round(offset * 100) / 100;
      fileOffsetNote = "Found in this sequence, so the start time was set for you.";
    } else {
      fileOffset = 0;
      fileOffsetNote = null;
    }
  }

  // Clips selected (or copied) in the timeline.
  async function useTimelineSelection(): Promise<boolean> {
    const res = await hostApi.getSelectedClips();
    if (!res?.success) {
      error = res?.error || "Couldn't read the timeline selection.";
      return false;
    }
    if (!res.clips.length) return false;
    selection = res;
    source = "selection";
    error = null;
    notice = res.skipped?.length ? `Skipped: ${res.skipped.join(", ")}.` : null;
    return true;
  }

  // Media selected (or dragged) in the Project panel.
  async function useProjectSelection(): Promise<boolean> {
    const res = await hostApi.getProjectSelection();
    if (!res?.success) {
      error = res?.error || "Couldn't read the Project panel selection.";
      return false;
    }
    const item = res.items?.[0];
    if (!item) return false;
    if (item.clips) {
      // A nested sequence: caption its audio, placed where the nest sits in this sequence.
      if (!item.clips.length) {
        error = `"${item.name}" has no audio clips inside.`;
        return true;
      }
      const offset = item.timelineOffset ?? 0;
      const clips = item.clips.map((c: any) => ({ ...c, start: c.start + offset, end: c.end + offset }));
      selection = { clips, skipped: item.skipped ?? [], duration: Math.max(...clips.map((c: any) => c.end)) };
      source = "selection";
      error = null;
      notice =
        item.timelineOffset === null
          ? `"${item.name}" isn't used in this sequence, so its captions are timed to its own 00:00.`
          : `Using the audio inside "${item.name}", placed where it sits in this sequence.`;
      return true;
    }
    setFile(item.name, item.path, item.timelineOffset);
    error = null;
    return true;
  }

  async function pasteFromPremiere() {
    if (busy) return;
    if ((await useTimelineSelection()) || (await useProjectSelection())) return;
    error = "Nothing to paste. Select or copy a clip in the timeline (or an item in the Project panel), then press Ctrl+V here.";
  }

  const isTyping = (target: EventTarget | null) =>
    target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);

  function onPaste(e: ClipboardEvent) {
    if (!canUseFiles || isTyping(e.target)) return;
    lastPasteAt = Date.now();
    e.preventDefault();
    const f = e.clipboardData?.files?.[0];
    if (f && !busy) {
      source = "file";
      useBrowserFile(f);
    } else {
      pasteFromPremiere();
    }
  }

  // Inside Premiere, Ctrl+V doesn't always produce a paste event, so handle the key too.
  function onKeydown(e: KeyboardEvent) {
    if (!canUseFiles || isTyping(e.target)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      setTimeout(() => {
        if (Date.now() - lastPasteAt > 150) pasteFromPremiere();
      }, 80);
    }
  }

  // A path dropped as text (e.g. from Explorer's address bar or another app).
  function pathFromText(text: string): string | null {
    const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (!line) return null;
    if (/^file:\/\//i.test(line)) return decodeURIComponent(line.replace(/^file:\/{2,3}/i, ""));
    if (/^[a-zA-Z]:[\\/]|^\//.test(line)) return line;
    return null;
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    if (busy || !canUseFiles) return;
    const f = e.dataTransfer?.files?.[0];
    if (f) {
      source = "file";
      useBrowserFile(f);
      return;
    }
    const dropped = pathFromText(e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain") || "");
    if (dropped) {
      setFile(dropped.split(/[\\/]/).pop() || dropped, dropped, null);
      return;
    }
    // Dragging from the Project panel selects the item there, so use that selection.
    if (!(await useProjectSelection()) && !(await useTimelineSelection())) {
      error = "Premiere didn't say what was dropped. Select the item in the Project panel and click \"Use Project panel selection\".";
    }
  }

  async function usePlayhead() {
    try {
      fileOffset = Math.round((await hostApi.getPlayheadSeconds()) * 100) / 100;
    } catch {}
  }
</script>

<svelte:window onpaste={onPaste} onkeydown={onKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="border-b border-panel-border"
  ondragenter={(e) => { if (canUseFiles) { e.preventDefault(); dragging = true; } }}
  ondragover={(e) => { if (canUseFiles) { e.preventDefault(); dragging = true; } }}
  ondragleave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dragging = false; }}
  ondrop={onDrop}
>
  <SectionHeader title="Offline Captions" icon={AudioLines} open={isOpen} onToggle={() => (isOpen = !isOpen)} />

  {#if isOpen}
    <div class="px-3 py-2.5 space-y-2.5">
      {#if !engine}
        <p class="text-[12px] text-panel-secondary">Checking offline engine…</p>
      {:else if !engine.available || (engine.platform === "mac" && (!engine.whisper || !engine.ffmpeg))}
        <p class="text-[12px] text-warning">{engine.message}</p>
        <button onclick={refreshEngine} class="text-[12px] text-accent bg-transparent border-none cursor-pointer p-0">Check again</button>
      {:else}
        {#if canUseFiles}
          <div class="grid grid-cols-3 gap-1.5">
            {#each [{ v: "timeline", l: "Whole timeline" }, { v: "selection", l: "Selected clips" }, { v: "file", l: "Audio file" }] as opt}
              <button
                onclick={() => (source = opt.v as Source)}
                disabled={busy}
                class="py-1.5 rounded border cursor-pointer text-[12px] font-medium transition-colors"
                style="border-color:{source === opt.v ? 'var(--color-accent)' : 'var(--color-panel-border)'};background:{source === opt.v ? 'var(--color-accent-soft)' : 'var(--color-surface-raised)'};color:{source === opt.v ? 'var(--color-accent)' : 'var(--color-panel-text)'}"
              >
                {opt.l}
              </button>
            {/each}
          </div>
        {/if}

        {#if source === "timeline"}
          <p class="text-[12px] text-panel-secondary leading-snug">
            Transcribes the unmuted audio tracks on your timeline on this computer. Captions are timed to the sequence, so they line up with the audio.
          </p>
          {#if canUseFiles}
            {#if trackScan}
              <div class="rounded border border-panel-border divide-y divide-panel-border">
                {#each trackScan.tracks as track (track.index)}
                  {@const usable = !track.muted && track.clipCount > 0}
                  <div class="flex items-center gap-2 px-2 py-1.5" class:opacity-50={!usable}>
                    <input
                      type="checkbox"
                      bind:checked={trackChecked[track.index]}
                      disabled={!usable || busy}
                      class="accent-accent"
                      aria-label="Include {track.name}"
                    />
                    <span class="text-[12px] text-panel-text truncate flex-1" title={track.name}>{track.name}</span>
                    <span class="text-[11px] text-panel-secondary shrink-0">
                      {track.muted ? "muted" : track.clipCount === 0 ? "empty" : `${track.clipCount} clip${track.clipCount === 1 ? "" : "s"}`}
                    </span>
                    {#if separateTracks && colorBySpeaker && usable}
                      <input
                        type="color"
                        bind:value={trackColors[track.name]}
                        class="w-5 h-5 rounded border border-panel-border cursor-pointer p-0 shrink-0"
                        title="Caption colour for {track.name}"
                      />
                    {/if}
                  </div>
                {/each}
              </div>
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" bind:checked={separateTracks} disabled={busy} class="accent-accent" />
                <span class="text-[12px] text-panel-text">Caption each track separately (one speaker per track)</span>
              </label>
              {#if separateTracks}
                <label class="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    bind:checked={colorBySpeaker}
                    onchange={() => writePref("bc-color-speakers", colorBySpeaker ? "1" : "0")}
                    disabled={busy}
                    class="accent-accent"
                  />
                  <span class="text-[12px] text-panel-text">Colour each speaker</span>
                </label>
                <p class="text-[11px] text-panel-secondary leading-snug">
                  Best when each person has their own mic track. Overlapping speech is captioned for both speakers and shown stacked.
                </p>
              {/if}
              <button onclick={scanTracks} disabled={busy || scanning} class="text-[12px] text-accent bg-transparent border-none cursor-pointer p-0">
                {scanning ? "Scanning…" : "Scan again"}
              </button>
            {:else}
              <button
                onclick={scanTracks}
                disabled={busy || scanning}
                class="w-full py-1.5 rounded text-[12px] border border-panel-border bg-surface-raised text-panel-text cursor-pointer hover:bg-panel-hover-bg"
              >
                {scanning ? "Scanning…" : "Scan audio tracks (choose tracks, caption speakers separately)"}
              </button>
            {/if}
          {/if}
        {:else if source === "selection"}
          {#if selection?.clips.length}
            <div class="rounded border border-panel-border px-2.5 py-2 space-y-1">
              {#each selection.clips.slice(0, 5) as clip}
                <div class="flex items-center justify-between gap-2 text-[12px]">
                  <span class="text-panel-text truncate" title={clip.name}>{clip.name}</span>
                  <span class="text-panel-secondary font-mono shrink-0">{formatTime(clip.start)}–{formatTime(clip.end)}</span>
                </div>
              {/each}
              {#if selection.clips.length > 5}
                <div class="text-[11px] text-panel-secondary">and {selection.clips.length - 5} more</div>
              {/if}
            </div>
          {:else}
            <p class="text-[12px] text-panel-secondary leading-snug">
              Select (or copy) one or more audio clips in the timeline, then press <b>Ctrl+V</b> in this panel or click the button below.
            </p>
          {/if}
          <button
            onclick={async () => { if (!(await useTimelineSelection()) && !error) error = "No clips are selected in the timeline."; }}
            disabled={busy}
            class="w-full py-1.5 rounded text-[12px] border border-panel-border bg-surface-raised text-panel-text cursor-pointer hover:bg-panel-hover-bg"
          >
            {selection?.clips.length ? "Use the current timeline selection instead" : "Use selected timeline clips"}
          </button>
          <p class="text-[11px] text-panel-secondary leading-snug">
            Only these clips are transcribed, at their places on the timeline, so the captions line up.
          </p>
        {:else}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="rounded border-2 border-dashed px-3 py-4 text-center cursor-pointer transition-colors"
            style="border-color:{dragging ? 'var(--color-accent)' : 'var(--color-panel-border)'};background:{dragging ? 'var(--color-accent-soft)' : 'transparent'}"
            onclick={() => !busy && chooseFile()}
            onkeydown={(e) => e.key === "Enter" && !busy && chooseFile()}
            role="button"
            tabindex="0"
          >
            {#if file}
              <div class="text-[13px] text-panel-text font-medium truncate" title={file.path}>{file.name}</div>
              <div class="text-[11px] text-panel-secondary mt-0.5">Click or drop to choose a different file</div>
            {:else}
              <div class="text-[13px] text-panel-text">Drop a file here, from Explorer or the Project panel</div>
              <div class="text-[11px] text-panel-secondary mt-0.5">or click to choose one (WAV, MP3, M4A, MP4, MOV…)</div>
            {/if}
          </div>
          <input
            bind:this={fileInput}
            type="file"
            accept="audio/*,video/*"
            class="hidden"
            onchange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) useBrowserFile(f);
            }}
          />
          <button
            onclick={async () => { if (!(await useProjectSelection()) && !error) error = "Nothing with a media file is selected in the Project panel."; }}
            disabled={busy}
            class="w-full py-1.5 rounded text-[12px] border border-panel-border bg-surface-raised text-panel-text cursor-pointer hover:bg-panel-hover-bg"
          >
            Use Project panel selection
          </button>
          <div class="flex items-end gap-2">
            <label class="flex flex-col gap-1 flex-1">
              <span class="text-[12px] text-panel-secondary">Captions start at (seconds) — {formatTime(Number(fileOffset) || 0)}</span>
              <input
                type="number"
                min="0"
                step="0.01"
                bind:value={fileOffset}
                disabled={busy}
                class="bg-surface-raised text-panel-text text-[12px] px-1.5 py-1.5 rounded border border-panel-border outline-none w-full"
              />
            </label>
            <button
              onclick={usePlayhead}
              disabled={busy}
              class="py-1.5 px-2.5 rounded text-[12px] border border-panel-border bg-surface-raised text-panel-text cursor-pointer hover:bg-panel-hover-bg"
            >
              Use playhead
            </button>
          </div>
          <p class="text-[11px] leading-snug" class:text-success={!!fileOffsetNote} class:text-panel-secondary={!fileOffsetNote}>
            {fileOffsetNote ?? "Set this to where the file's start sits on your timeline (0 if it starts at the beginning), so the captions line up."}
          </p>
        {/if}

        <div class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between gap-2 text-[12px]">
            <span class="text-panel-secondary">Speech model</span>
            <span class="text-panel-text">Large v3 Turbo{engine.models.includes(model) ? "" : " (not installed)"}</span>
          </div>
          <label class="flex flex-col gap-1">
            <span class="text-[12px] text-panel-secondary">Language</span>
            <select
              bind:value={language}
              disabled={busy}
              class="bg-surface-raised text-panel-text text-[12px] px-1.5 py-1.5 rounded border border-panel-border outline-none w-full"
            >
              {#each languages as l}
                <option value={l.value}>{l.label}</option>
              {/each}
            </select>
          </label>
        </div>

        {#if preparing}
          <p class="text-[12px] text-accent">{preparing}</p>
        {:else if job && jobStatus}
          <div class="space-y-1.5">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[12px] text-accent truncate">{jobStatus.message || "Working…"}</span>
              {#if jobStatus.progress >= 0}
                <span class="text-[12px] text-panel-secondary shrink-0">{jobStatus.progress}%</span>
              {/if}
            </div>
            <div class="h-1.5 rounded-full bg-surface-raised overflow-hidden">
              <div
                class="h-full bg-accent transition-all"
                class:animate-pulse={jobStatus.progress < 0}
                style="width:{jobStatus.progress >= 0 ? jobStatus.progress : 100}%"
              ></div>
            </div>
            <button
              onclick={cancel}
              class="w-full py-1.5 rounded text-[12px] border border-panel-border bg-transparent text-panel-text cursor-pointer hover:bg-panel-hover-bg"
            >
              Cancel
            </button>
          </div>
        {:else if !engine.ready || !modelInstalled}
          <button
            onclick={runSetup}
            class="w-full py-2 rounded text-[13px] font-semibold border-none cursor-pointer bg-accent hover:bg-accent-hover text-accent-ink"
          >
            {onlyDetectorMissing && modelInstalled
              ? "Finish setup (1 MB speech detector)"
              : engine.ready
                ? "Download the speech model (574 MB)"
                : "Set up offline engine (one-time download)"}
          </button>
          <p class="text-[11px] text-panel-secondary">
            {#if onlyDetectorMissing && modelInstalled}
              Adds speech detection, so music and silence no longer turn into made-up captions.
            {:else if engine.platform === "win" && (!engine.whisper || !engine.ffmpeg)}
              Downloads whisper.cpp, ffmpeg and the speech model (about 700 MB). After this, no internet is needed.
            {:else}
              The installer normally does this. Downloads the speech model once; after this, no internet is needed.
            {/if}
          </p>
        {:else}
          <button
            onclick={runTranscription}
            disabled={(source === "file" && !file) || (source === "selection" && !selection?.clips.length)}
            class="w-full py-2 rounded text-[13px] font-semibold border-none cursor-pointer bg-accent hover:bg-accent-hover text-accent-ink disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {#if source === "file"}
              {file ? "Generate captions from this file" : "Choose a file first"}
            {:else if source === "selection"}
              {selection?.clips.length ? "Generate captions for the selected clips" : "Select clips first"}
            {:else}
              {transcriptSource === "offline" ? "Regenerate captions from timeline audio" : "Generate captions from timeline audio"}
            {/if}
          </button>
        {/if}

        {#if transcriptSource === "offline" && !busy}
          <div class="flex items-center justify-between gap-2">
            <span class="text-[12px] text-success">Using offline captions</span>
            {#if canUsePremiereTranscript}
              <button onclick={usePremiere} class="text-[12px] text-accent bg-transparent border-none cursor-pointer p-0">
                Use Premiere transcript instead
              </button>
            {/if}
          </div>
        {/if}
      {/if}

      {#if error}
        <p class="text-[12px] text-error whitespace-pre-wrap break-words">{error}</p>
      {/if}
      {#if notice}
        <p class="text-[12px] text-panel-secondary break-words">{notice}</p>
      {/if}
    </div>
  {/if}
</div>
