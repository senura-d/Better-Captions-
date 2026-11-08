<script lang="ts">
  import type { AnimationConfig, CaptionItem, StyleConfig, TranscriptJSON } from "../lib/types";
  import { captionsToSrt, transcriptToTxt } from "../lib/export/text";
  import { formatTime } from "../lib/transcript/parser";

  interface Props {
    captions: CaptionItem[];
    transcript: TranscriptJSON | null;
    style: StyleConfig;
    animation: AnimationConfig;
    frameWidth: number;
    frameRate: number;
    sequenceName: string;
    hostApi: any;
    // The CEP extension can add straight to the timeline; UXP saves files instead.
    canAddToTimeline: boolean;
  }

  let { captions, transcript, style, animation, frameWidth, frameRate, sequenceName, hostApi, canAddToTimeline }: Props =
    $props();

  let busy = $state<string | null>(null);
  let progress = $state<number | null>(null);
  let status = $state<string | null>(null);
  let error = $state<string | null>(null);

  const baseName = () => sequenceName.replace(/[\\/:*?"<>|]/g, "_").trim() || "captions";
  let empty = $derived(captions.length === 0);

  async function run(label: string, task: () => Promise<void>) {
    if (busy || empty) return;
    busy = label;
    progress = null;
    status = null;
    error = null;
    try {
      await task();
    } catch (e: any) {
      error = e?.message || String(e);
    } finally {
      busy = null;
      progress = null;
    }
  }

  const addAnimated = () =>
    run("Rendering animated captions", async () => {
      const res = await hostApi.addAnimatedCaptions(
        $state.snapshot(captions),
        $state.snapshot(style),
        $state.snapshot(animation),
        frameWidth,
        frameRate,
        sequenceName,
        (p: number) => (progress = p),
      );
      if (!res?.success) throw new Error(res?.error || "Couldn't add the captions to the timeline.");
      status =
        `Added to V${res.trackNumber} at ${formatTime(res.start)}` +
        (res.addedTrack ? " (on a new track)" : "") +
        (res.positioned ? "." : ". Move it into place with the clip's Motion > Position if needed.");
    });

  const addEditable = () =>
    run("Adding Premiere captions", async () => {
      const res = await hostApi.addPremiereCaptions(captionsToSrt(captions), sequenceName);
      if (!res?.success) throw new Error(res?.error || "Couldn't add the captions to the timeline.");
      status = res.placed
        ? "Added as a caption track. Edit and style it with Premiere's caption tools."
        : "Imported into the project. Drag the caption item onto the timeline at 00:00.";
    });

  const saveFile = (kind: "srt" | "txt") =>
    run(`Saving ${kind.toUpperCase()}`, async () => {
      const content = kind === "srt" ? captionsToSrt(captions) : transcriptToTxt(transcript, captions);
      const saved = await hostApi.saveTextFile(`${baseName()}.${kind}`, kind, content);
      if (saved?.cancelled) return;
      if (!saved?.success) throw new Error(saved?.error || "Couldn't save the file.");
      status = `Saved ${saved.path}`;
    });
</script>

<div class="px-3 pt-3 space-y-2">
  {#if canAddToTimeline}
    <div class="text-[12.5px] font-semibold text-panel-text">Add to timeline</div>
    <button
      onclick={addAnimated}
      disabled={!!busy || empty}
      class="w-full py-2.5 rounded-md text-[13px] font-semibold border-none cursor-pointer bg-accent hover:bg-accent-hover text-accent-ink disabled:opacity-50 disabled:cursor-not-allowed"
    >
      Add animated captions to timeline
    </button>
    <p class="text-[11px] text-panel-secondary leading-snug">
      Exactly as previewed (style, glow, animation, fades), as one transparent video clip on the top video track.
    </p>
    <button
      onclick={addEditable}
      disabled={!!busy || empty}
      class="w-full py-2 rounded-md text-[12px] font-semibold cursor-pointer border border-panel-border bg-surface-raised text-panel-text hover:bg-panel-hover-bg disabled:opacity-50 disabled:cursor-not-allowed"
    >
      Add as editable Premiere captions
    </button>
    <p class="text-[11px] text-panel-secondary leading-snug">
      Plain captions on a caption track that you can edit and restyle in Premiere (no animation).
    </p>
    <div class="flex items-center gap-3 pt-0.5">
      <span class="text-[11px] text-panel-secondary">Save a file instead:</span>
      <button onclick={() => saveFile("srt")} disabled={!!busy || empty} class="text-[12px] text-accent bg-transparent border-none cursor-pointer p-0 disabled:opacity-50">SRT</button>
      <button onclick={() => saveFile("txt")} disabled={!!busy || empty} class="text-[12px] text-accent bg-transparent border-none cursor-pointer p-0 disabled:opacity-50">TXT</button>
    </div>
  {:else}
    <div class="text-[12.5px] font-semibold text-panel-text">Export captions</div>
    <div class="grid grid-cols-2 gap-2">
      <button
        onclick={() => saveFile("srt")}
        disabled={!!busy || empty}
        class="py-2.5 rounded-md text-[13px] font-semibold border-none cursor-pointer bg-accent hover:bg-accent-hover text-accent-ink disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Export SRT
      </button>
      <button
        onclick={() => saveFile("txt")}
        disabled={!!busy || empty}
        class="py-2.5 rounded-md text-[13px] font-semibold cursor-pointer border border-panel-border bg-surface-raised text-panel-text hover:bg-panel-hover-bg disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Export TXT
      </button>
    </div>
  {/if}

  {#if busy}
    <div class="space-y-1">
      <div class="flex justify-between text-[12px]">
        <span class="text-accent">{busy}…</span>
        {#if progress !== null}<span class="text-panel-secondary">{progress}%</span>{/if}
      </div>
      <div class="h-1.5 rounded-full bg-surface-raised overflow-hidden">
        <div class="h-full bg-accent transition-all" class:animate-pulse={progress === null} style="width:{progress ?? 100}%"></div>
      </div>
    </div>
  {/if}
  {#if error}
    <p class="text-[12px] text-red-400 break-words">{error}</p>
  {/if}
  {#if status}
    <p class="text-[12px] text-green-400 break-words">{status}</p>
  {/if}
</div>
