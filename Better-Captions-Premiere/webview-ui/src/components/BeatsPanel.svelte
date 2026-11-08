<script lang="ts">
  import { analyzeBeats, beatMarkers, confidenceLabel, type BeatAnalysis, type BeatSpacing } from "../lib/beats";
  import { formatTime } from "../lib/transcript/parser";
  import { toolStatus } from "../lib/toolStatus.svelte";

  interface Props {
    hostApi: any;
    // On its own screen (from the home menu): always open, no collapsible header.
    standalone?: boolean;
  }

  let { hostApi, standalone = false }: Props = $props();

  type Source = "selection" | "track" | "project";
  interface Track {
    index: number;
    name: string;
    muted: boolean;
    clipCount: number;
  }

  let isOpen = $state(standalone);
  let source = $state<Source>("selection");
  let tracks = $state<Track[]>([]);
  let trackClips = $state<any[]>([]);
  let trackIndex = $state<number | null>(null);
  // A media clip (path) or a nested sequence (sequenceNodeId + its audio clips).
  let projectItem = $state<{ name: string; path: string; timelineOffset: number | null; sequenceNodeId?: string; clips?: any[] } | null>(null);
  let target = $state<"sequence" | "clip">("sequence");
  let isNest = $derived(!!projectItem?.clips);

  let spacing = $state<BeatSpacing>("every");
  let beatsPerBar = $state(4);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let status = $state<string | null>(null);

  // Result of the last analysis. Samples are kept (not reactive) so changing
  // "beats per bar" can re-run without decoding again.
  let analysis = $state<BeatAnalysis | null>(null);
  let analysedLabel = $state("");
  let analysedOffset = 0;
  let analysedTarget: { target: "sequence" | "clip" | "nested"; itemPath: string } = { target: "sequence", itemPath: "" };
  // "On the clip" means inside the nested sequence when the item is a nest.
  const itemTarget = () =>
    isNest ? { target: "nested" as const, itemPath: projectItem?.sequenceNodeId ?? "" } : { target: "clip" as const, itemPath: projectItem?.path ?? "" };
  let samples: Float32Array | null = null;

  let markers = $derived(analysis ? beatMarkers(analysis, spacing, analysedOffset) : []);
  let confidence = $derived(analysis ? confidenceLabel(analysis.confidence) : null);

  async function loadTracks() {
    const res = await hostApi.scanAudioTracks();
    if (!res?.success) throw new Error(res?.error || "Couldn't read the audio tracks.");
    tracks = res.tracks;
    trackClips = res.clips;
    if (trackIndex === null || !tracks.some((t) => t.index === trackIndex && t.clipCount > 0)) {
      trackIndex = tracks.find((t) => !t.muted && t.clipCount > 0)?.index ?? null;
    }
  }

  async function chooseSource(next: Source) {
    source = next;
    error = null;
    try {
      if (next === "track") await loadTracks();
      if (next === "project") await useProjectSelection();
    } catch (e: any) {
      error = e?.message || String(e);
    }
  }

  async function useProjectSelection() {
    const res = await hostApi.getProjectSelection();
    if (!res?.success) throw new Error(res?.error || "Couldn't read the Project panel selection.");
    projectItem = res.items?.[0] ?? null;
    target = projectItem?.timelineOffset !== null && projectItem?.timelineOffset !== undefined ? "sequence" : "clip";
    if (!projectItem) error = "Select an audio or video clip in the Project panel, then click Use Project panel selection.";
  }

  async function analyse() {
    if (busy) return;
    error = null;
    status = null;
    busy = "Reading audio";
    try {
      let audio: { samples: Float32Array; offset: number };
      if (source === "selection") {
        const sel = await hostApi.getSelectedClips();
        if (!sel?.success) throw new Error(sel?.error || "Couldn't read the timeline selection.");
        if (!sel.clips.length) throw new Error("Select the music clip(s) in the timeline first.");
        audio = await hostApi.decodeBeatAudio({ kind: "clips", clips: sel.clips }, (m: string) => (busy = m));
        analysedLabel = sel.clips.length === 1 ? sel.clips[0].name : `${sel.clips.length} selected clips`;
        analysedTarget = { target: "sequence", itemPath: "" };
      } else if (source === "track") {
        const clips = trackClips.filter((c) => c.track === trackIndex);
        if (!clips.length) throw new Error("Choose an audio track that has clips.");
        audio = await hostApi.decodeBeatAudio({ kind: "clips", clips }, (m: string) => (busy = m));
        analysedLabel = tracks.find((t) => t.index === trackIndex)?.name ?? "the track";
        analysedTarget = { target: "sequence", itemPath: "" };
      } else {
        if (!projectItem) await useProjectSelection();
        if (!projectItem) return;
        if (isNest) {
          if (!projectItem.clips!.length) throw new Error(`"${projectItem.name}" has no audio clips inside.`);
          audio = await hostApi.decodeBeatAudio({ kind: "clips", clips: $state.snapshot(projectItem.clips) }, (m: string) => (busy = m));
        } else {
          audio = await hostApi.decodeBeatAudio({ kind: "file", path: projectItem.path }, (m: string) => (busy = m));
        }
        analysedLabel = projectItem.name;
        analysedTarget = target === "sequence" ? { target: "sequence", itemPath: "" } : itemTarget();
        // Clip/nest markers use the item's own time; sequence markers its place on the timeline.
        if (target === "sequence") audio.offset += projectItem.timelineOffset ?? 0;
      }
      busy = "Detecting beats";
      await new Promise((r) => setTimeout(r, 30)); // let the status show before the heavy part
      samples = audio.samples;
      analysedOffset = audio.offset;
      analysis = analyzeBeats(samples, beatsPerBar);
      toolStatus.bpm = analysis.bpm;
      toolStatus.beatsSource = analysedLabel;
    } catch (e: any) {
      analysis = null;
      error = e?.message || String(e);
    } finally {
      busy = null;
    }
  }

  async function changeBeatsPerBar(n: number) {
    beatsPerBar = n;
    if (samples && analysis) analysis = analyzeBeats(samples, n);
  }

  async function addMarkers() {
    if (!analysis || busy) return;
    busy = "Adding markers";
    error = null;
    try {
      const res = await hostApi.addBeatMarkers(analysedTarget.target, analysedTarget.itemPath, markers, analysis.bpm, analysis.beatsPerBar);
      if (!res?.success) throw new Error(res?.error || "Couldn't add the markers.");
      const where =
        analysedTarget.target === "nested"
          ? `the nested sequence "${analysedLabel}" (open it to see them)`
          : analysedTarget.target === "clip"
            ? "the clip (open it in the Source monitor to see them)"
            : "the sequence";
      status = `Added ${res.added} beat markers to ${where}.` + (res.colored ? "" : " (This Premiere version didn't allow marker colours.)");
    } catch (e: any) {
      error = e?.message || String(e);
    } finally {
      busy = null;
    }
  }

  async function removeMarkers() {
    if (busy) return;
    busy = "Removing markers";
    error = null;
    try {
      const where = source === "project" && target === "clip" ? itemTarget() : { target: "sequence" as const, itemPath: "" };
      const res = await hostApi.removeBeatMarkers(where.target, where.itemPath);
      if (!res?.success) throw new Error(res?.error || "Couldn't remove the markers.");
      status = res.removed ? `Removed ${res.removed} beat markers.` : "There were no beat markers to remove.";
    } catch (e: any) {
      error = e?.message || String(e);
    } finally {
      busy = null;
    }
  }
</script>

<div class:border-b={!standalone} class="border-panel-border">
  {#if !standalone}
  <button
    onclick={() => (isOpen = !isOpen)}
    class="w-full px-3 py-2 flex items-center justify-between text-[12.5px] font-semibold text-panel-text bg-surface hover:bg-panel-hover-bg transition-colors cursor-pointer border-none"
  >
    <span>Beat Markers</span>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="transition-transform" class:rotate-180={isOpen}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  </button>
  {/if}

  {#if isOpen}
    <div class="px-3 py-2.5 space-y-2.5">
      <p class="text-[12px] text-panel-secondary leading-snug">
        Finds the tempo and beats in your music and adds coloured markers, so you can cut to the beat. Red = first beat of the bar, yellow = middle of the bar, blue = other beats.
      </p>

      <div class="grid grid-cols-3 gap-1.5">
        {#each [{ v: "selection", l: "Selected clips" }, { v: "track", l: "Audio track" }, { v: "project", l: "Project item" }] as opt}
          <button
            onclick={() => chooseSource(opt.v as Source)}
            disabled={!!busy}
            class="py-1.5 rounded border cursor-pointer text-[12px] font-medium transition-colors"
            style="border-color:{source === opt.v ? 'var(--color-accent)' : 'var(--color-panel-border)'};background:{source === opt.v ? 'var(--color-accent-soft)' : 'var(--color-surface-raised)'};color:{source === opt.v ? 'var(--color-accent)' : 'var(--color-panel-text)'}"
          >
            {opt.l}
          </button>
        {/each}
      </div>

      {#if source === "selection"}
        <p class="text-[11px] text-panel-secondary">Select the music clip(s) in the timeline (nested sequences work too), then click Analyse. Markers go on the sequence, at the beats.</p>
      {:else if source === "track"}
        <label class="flex flex-col gap-1">
          <span class="text-[12px] text-panel-secondary">Track</span>
          <select
            bind:value={trackIndex}
            disabled={!!busy}
            class="bg-surface-raised text-panel-text text-[12px] px-1.5 py-1.5 rounded border border-panel-border outline-none w-full"
          >
            {#each tracks as t (t.index)}
              <option value={t.index} disabled={t.muted || t.clipCount === 0}>
                {t.name} {t.muted ? "(muted)" : t.clipCount === 0 ? "(empty)" : `(${t.clipCount} clip${t.clipCount === 1 ? "" : "s"})`}
              </option>
            {/each}
          </select>
        </label>
      {:else}
        <div class="flex items-center justify-between gap-2">
          <span class="text-[12px] text-panel-text truncate">{projectItem ? projectItem.name : "Nothing selected"}</span>
          <button onclick={() => chooseSource("project")} disabled={!!busy} class="text-[12px] text-accent bg-transparent border-none cursor-pointer p-0 shrink-0">
            Use Project panel selection
          </button>
        </div>
        {#if projectItem}
          <div class="flex gap-3 text-[12px]">
            <label class="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" bind:group={target} value="clip" class="accent-accent" /> {isNest ? "Inside the nested sequence" : "On the clip"}
            </label>
            <label class="flex items-center gap-1.5 cursor-pointer" class:opacity-50={projectItem.timelineOffset === null}>
              <input type="radio" bind:group={target} value="sequence" disabled={projectItem.timelineOffset === null} class="accent-accent" />
              On the sequence{projectItem.timelineOffset === null ? " (not used in it)" : ""}
            </label>
          </div>
        {/if}
      {/if}

      <button
        onclick={analyse}
        disabled={!!busy}
        class="w-full py-2 rounded-md text-[13px] font-semibold border-none cursor-pointer bg-accent hover:bg-accent-hover text-accent-ink disabled:opacity-50"
      >
        {busy && !analysis ? `${busy}…` : "Analyse beats"}
      </button>

      {#if analysis && confidence}
        <div class="rounded-md border border-panel-border p-2.5 space-y-2">
          <div class="flex items-baseline justify-between">
            <span class="text-[22px] font-semibold text-panel-text">{analysis.bpm} <span class="text-[12px] text-panel-secondary font-normal">BPM</span></span>
            <span class="text-[11px] text-panel-secondary truncate ml-2" title={analysedLabel}>{analysedLabel}</span>
          </div>
          <div class="flex items-center gap-1.5">
            <span
              class="w-2.5 h-2.5 rounded-full shrink-0"
              class:bg-success={confidence.tone === "good"}
              class:bg-warning={confidence.tone === "ok"}
              class:bg-red-400={confidence.tone === "poor"}
            ></span>
            <span class="text-[12px] text-panel-text">{Math.round(analysis.confidence * 100)}% confidence. {confidence.label}</span>
          </div>
          <div class="text-[11px] text-panel-secondary">
            {analysis.beats.length} beats, first at {formatTime(analysis.beats[0] + analysedOffset)}
          </div>

          <div class="grid grid-cols-3 gap-1.5">
            {#each [{ v: "every", l: "Every beat" }, { v: "every2", l: "Every 2nd" }, { v: "downbeats", l: "Bar starts" }] as opt}
              <button
                onclick={() => (spacing = opt.v as BeatSpacing)}
                class="py-1 rounded border cursor-pointer text-[12px] transition-colors"
                style="border-color:{spacing === opt.v ? 'var(--color-accent)' : 'var(--color-panel-border)'};background:{spacing === opt.v ? 'var(--color-accent-soft)' : 'var(--color-surface-raised)'};color:{spacing === opt.v ? 'var(--color-accent)' : 'var(--color-panel-text)'}"
              >
                {opt.l}
              </button>
            {/each}
          </div>
          <label class="flex items-center justify-between gap-2">
            <span class="text-[12px] text-panel-secondary">Beats per bar</span>
            <select
              value={beatsPerBar}
              onchange={(e) => changeBeatsPerBar(Number((e.target as HTMLSelectElement).value))}
              class="bg-surface-raised text-panel-text text-[12px] px-1.5 py-1 rounded border border-panel-border outline-none"
            >
              <option value={3}>3 (waltz)</option>
              <option value={4}>4 (most music)</option>
              <option value={6}>6</option>
            </select>
          </label>

          <button
            onclick={addMarkers}
            disabled={!!busy || !markers.length}
            class="w-full py-2 rounded-md text-[13px] font-semibold border-none cursor-pointer bg-accent hover:bg-accent-hover text-accent-ink disabled:opacity-50"
          >
            {busy === "Adding markers" ? "Adding markers…" : `Add ${markers.length} beat markers`}
          </button>
        </div>
      {/if}

      <button
        onclick={removeMarkers}
        disabled={!!busy}
        class="w-full py-1.5 rounded text-[12px] border border-panel-border bg-surface-raised text-panel-text cursor-pointer hover:bg-panel-hover-bg"
      >
        Remove beat markers{source === "project" && target === "clip" ? (isNest ? " from the nested sequence" : " from the clip") : " from the sequence"}
      </button>

      {#if busy && analysis}
        <p class="text-[12px] text-accent">{busy}…</p>
      {/if}
      {#if error}
        <p class="text-[12px] text-red-400 break-words">{error}</p>
      {/if}
      {#if status}
        <p class="text-[12px] text-green-400 break-words">{status}</p>
      {/if}
    </div>
  {/if}
</div>
