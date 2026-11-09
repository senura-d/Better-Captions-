<script module lang="ts">
  export type Tool = "captions" | "beats" | "luts";
</script>

<script lang="ts">
  import Captions from "@lucide/svelte/icons/captions";
  import AudioWaveform from "@lucide/svelte/icons/audio-waveform";
  import SwatchBook from "@lucide/svelte/icons/swatch-book";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";

  interface Props {
    onOpen: (tool: Tool) => void;
    captionsStatus: string;
    beatsStatus: string;
    lutsStatus: string;
    // Beat Markers and LUT Preview need the CEP extension (Node.js and ffmpeg).
    fullTools: boolean;
  }

  let { onOpen, captionsStatus, beatsStatus, lutsStatus, fullTools }: Props = $props();

  let tools = $derived([
    {
      id: "captions" as Tool,
      icon: Captions,
      name: "Captions",
      desc: "Transcribe the timeline offline, style the words and add them as a clip.",
      status: captionsStatus,
      enabled: true,
    },
    {
      id: "beats" as Tool,
      icon: AudioWaveform,
      name: "Beat Markers",
      desc: "Find the tempo of your music and mark every beat or bar.",
      status: fullTools ? beatsStatus : "Needs the extension version",
      enabled: fullTools,
    },
    {
      id: "luts" as Tool,
      icon: SwatchBook,
      name: "LUT Preview",
      desc: "Try LUTs on the clip under the playhead and keep the one you like.",
      status: fullTools ? lutsStatus : "Needs the extension version",
      enabled: fullTools,
    },
  ]);
</script>

<nav class="tools" aria-label="Tools">
  {#each tools as t (t.id)}
    <button class="row" onclick={() => onOpen(t.id)} disabled={!t.enabled}>
      <span class="glyph"><t.icon size={18} strokeWidth={1.75} /></span>
      <span class="text">
        <span class="name">{t.name}</span>
        <span class="desc">{t.desc}</span>
        <span class="status">{t.status}</span>
      </span>
      <ChevronRight size={16} strokeWidth={1.75} class="chev" />
    </button>
  {/each}
</nav>

<style>
  .tools {
    display: flex;
    flex-direction: column;
    margin: 10px;
    border: 1px solid var(--color-panel-border);
    border-radius: 6px;
    background: var(--color-surface);
    overflow: hidden;
  }
  .row {
    display: grid;
    grid-template-columns: 32px 1fr 16px;
    gap: 12px;
    align-items: center;
    width: 100%;
    padding: 12px 12px 12px 12px;
    border: none;
    border-top: 1px solid var(--color-panel-border);
    background: transparent;
    color: var(--color-panel-text);
    text-align: left;
    cursor: pointer;
  }
  .row:first-child {
    border-top: none;
  }
  .row:hover:not(:disabled) {
    background: var(--color-surface-raised);
  }
  .row:focus-visible {
    outline-offset: -2px;
  }
  .row:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .glyph {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 5px;
    background: var(--color-surface-raised);
    color: var(--color-panel-secondary);
    align-self: start;
  }
  .row:hover:not(:disabled) .glyph {
    color: var(--color-panel-text);
    background: var(--color-surface-overlay);
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
  }
  .desc {
    margin-top: 2px;
    color: var(--color-panel-secondary);
    font-size: 12px;
    line-height: 1.4;
  }
  .status {
    margin-top: 6px;
    color: var(--color-panel-tertiary);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row :global(.chev) {
    color: var(--color-panel-tertiary);
  }
  .row:hover:not(:disabled) :global(.chev) {
    color: var(--color-panel-text);
  }
</style>
