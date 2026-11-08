<script module lang="ts">
  export type Tool = "captions" | "beats" | "luts";
</script>

<script lang="ts">
  interface Props {
    onOpen: (tool: Tool) => void;
    captionsStatus: string;
    beatsStatus: string;
    lutsStatus: string;
    // Beat Markers and LUT Preview need the CEP extension (Node.js and ffmpeg).
    fullTools: boolean;
  }

  let { onOpen, captionsStatus, beatsStatus, lutsStatus, fullTools }: Props = $props();

  const words = ["Words", "land", "on", "time"];
</script>

<div class="home">
  <p class="intro">Pick a tool. Everything runs on this computer.</p>

  <button class="tool tool-captions" onclick={() => onOpen("captions")}>
    <div class="visual caption-visual" aria-hidden="true">
      <span class="caption-line">
        {#each words as w, i}<span class="w" style="--i:{i}">{w}</span>{" "}{/each}
      </span>
    </div>
    <div class="body">
      <span class="name font-display">Captions</span>
      <span class="desc">Transcribe your timeline offline, style and animate the words, and add them to the timeline.</span>
      <span class="status">{captionsStatus}</span>
    </div>
  </button>

  <button class="tool tool-beats" onclick={() => onOpen("beats")} disabled={!fullTools}>
    <div class="visual beat-visual" aria-hidden="true">
      {#each Array(16) as _, i}<span class="bar" class:down={i % 4 === 0} style="--i:{i}"></span>{/each}
    </div>
    <div class="body">
      <span class="name font-display">Beat Markers</span>
      <span class="desc">Find the tempo of your music and drop coloured markers on every beat or bar.</span>
      <span class="status">{fullTools ? beatsStatus : "Available in the extension version"}</span>
    </div>
  </button>

  <button class="tool tool-luts" onclick={() => onOpen("luts")} disabled={!fullTools}>
    <div class="visual lut-visual" aria-hidden="true">
      <div class="scene"></div>
      <div class="scene graded"></div>
      <span class="divider"></span>
    </div>
    <div class="body">
      <span class="name font-display">LUT Preview</span>
      <span class="desc">See your LUTs on the frame under the playhead, compare before and after, then apply.</span>
      <span class="status">{fullTools ? lutsStatus : "Available in the extension version"}</span>
    </div>
  </button>
</div>

<style>
  .home {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 12px 16px;
  }
  .intro {
    margin: 0 2px 2px;
    color: var(--color-panel-secondary);
    font-size: 12.5px;
  }

  .tool {
    display: grid;
    grid-template-columns: 108px 1fr;
    gap: 12px;
    align-items: center;
    width: 100%;
    padding: 10px;
    border-radius: 10px;
    border: 1px solid var(--color-panel-border);
    background: var(--color-surface);
    color: var(--color-panel-text);
    text-align: left;
    cursor: pointer;
    transition: border-color 140ms, background 140ms;
  }
  .tool:hover:not(:disabled),
  .tool:focus-visible {
    border-color: var(--color-accent);
    background: var(--color-surface-raised);
  }
  .tool:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .name {
    font-size: 17px;
    line-height: 1.15;
  }
  .desc {
    color: var(--color-panel-secondary);
    font-size: 12px;
    line-height: 1.4;
  }
  .status {
    margin-top: 2px;
    color: var(--color-accent);
    font-size: 11.5px;
    font-weight: 600;
  }

  /* Each tool's small picture of what it does; it moves while hovered or focused. */
  .visual {
    position: relative;
    height: 64px;
    border-radius: 7px;
    overflow: hidden;
    background: #18181b;
  }

  .caption-visual {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding-bottom: 9px;
    background: linear-gradient(160deg, #3b3f4a, #1d1f25 70%);
  }
  .caption-line {
    padding: 2px 5px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.55);
    font-size: 9.5px;
    font-weight: 700;
    color: #fff;
    white-space: nowrap;
  }
  .w:nth-child(2) {
    color: var(--color-accent);
  }
  .tool:hover .w,
  .tool:focus-visible .w {
    animation: speak 2.5s steps(1) infinite;
    animation-delay: calc(var(--i) * 0.5s);
    color: #fff;
  }
  @keyframes speak {
    0%, 20% { color: var(--color-accent); }
    20.01%, 100% { color: #fff; }
  }

  .beat-visual {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    padding: 0 8px;
  }
  .bar {
    width: 3px;
    height: 16px;
    border-radius: 2px;
    background: #55555f;
  }
  .bar.down {
    height: 30px;
    background: var(--color-accent);
  }
  .tool:hover .bar,
  .tool:focus-visible .bar {
    animation: pulse 2s ease-out infinite;
    animation-delay: calc(var(--i) * 0.125s);
  }
  @keyframes pulse {
    0% { transform: scaleY(1.45); filter: brightness(1.5); }
    30%, 100% { transform: scaleY(1); filter: none; }
  }

  .lut-visual .scene {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(circle at 70% 30%, #e9e1cf 0 9px, transparent 10px),
      linear-gradient(180deg, #8fa3b0 0%, #b9b3a6 52%, #5b5e55 53%, #3f423b 100%);
    filter: saturate(0.55) contrast(0.9);
  }
  .lut-visual .graded {
    clip-path: inset(0 0 0 50%);
    filter: saturate(1.35) contrast(1.15) sepia(0.25) hue-rotate(-12deg);
  }
  .lut-visual .divider {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 2px;
    background: #fff;
  }
  .tool:hover .graded,
  .tool:focus-visible .graded {
    animation: wipe 3s ease-in-out infinite alternate;
  }
  .tool:hover .divider,
  .tool:focus-visible .divider {
    animation: wipe-line 3s ease-in-out infinite alternate;
  }
  @keyframes wipe {
    from { clip-path: inset(0 0 0 22%); }
    to { clip-path: inset(0 0 0 78%); }
  }
  @keyframes wipe-line {
    from { left: 22%; }
    to { left: 78%; }
  }
</style>
