<script lang="ts">
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Film from "@lucide/svelte/icons/film";
  import { formatTime } from "../lib/transcript/parser";

  interface Props {
    title: string;
    onBack?: () => void;
    sequenceName: string | null;
    duration?: number;
    onRefresh: () => void;
  }

  let { title, onBack, sequenceName, duration, onRefresh }: Props = $props();
</script>

<header class="app-bar">
  <div class="left">
    {#if onBack}
      <button class="icon-btn" onclick={onBack} aria-label="Back to tools" title="Back to tools">
        <ChevronLeft size={16} strokeWidth={2} />
      </button>
    {/if}
    <h1 class:pad={!onBack}>{title}</h1>
  </div>
  <div class="right">
    <span class="seq" class:none={!sequenceName} title={sequenceName ?? "No sequence open"}>
      <Film size={13} strokeWidth={1.75} />
      <span class="seq-name">{sequenceName ?? "No sequence"}</span>
      {#if sequenceName && duration}<span class="seq-time">{formatTime(duration).slice(0, 5)}</span>{/if}
    </span>
    <button class="icon-btn" onclick={onRefresh} aria-label="Refresh sequence" title="Refresh sequence">
      <RefreshCw size={13} strokeWidth={1.75} />
    </button>
  </div>
</header>

<style>
  .app-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: 36px;
    padding: 0 4px;
    border-bottom: 1px solid var(--color-panel-border);
    flex-shrink: 0;
  }
  .left,
  .right {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  h1.pad {
    padding-left: 8px;
  }
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 4px;
    border: none;
    background: transparent;
    color: var(--color-panel-secondary);
    cursor: pointer;
    flex-shrink: 0;
  }
  .icon-btn:hover {
    background: var(--color-surface-raised);
    color: var(--color-panel-text);
  }
  .seq {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 200px;
    padding: 0 6px;
    color: var(--color-panel-secondary);
    font-size: 12px;
  }
  .seq-name {
    color: var(--color-panel-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .seq-time {
    font-variant-numeric: tabular-nums;
  }
  .seq.none .seq-name {
    color: var(--color-panel-secondary);
  }
</style>
