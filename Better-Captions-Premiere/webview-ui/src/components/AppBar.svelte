<script lang="ts">
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
  <div class="flex items-center gap-1.5 min-w-0">
    {#if onBack}
      <button class="icon-btn" onclick={onBack} aria-label="Back to the menu" title="Back to the menu">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
    {:else}
      <span class="mark" aria-hidden="true"></span>
    {/if}
    <h1 class="font-display text-[15px] text-panel-text truncate">{title}</h1>
  </div>
  <div class="flex items-center gap-1 min-w-0">
    <span class="seq-chip" class:none={!sequenceName} title={sequenceName ?? "No sequence open"}>
      <span class="dot"></span>
      <span class="truncate">{sequenceName ?? "No sequence"}</span>
      {#if sequenceName && duration}<span class="font-display opacity-70">{formatTime(duration).slice(0, 5)}</span>{/if}
    </span>
    <button class="icon-btn" onclick={onRefresh} aria-label="Refresh" title="Refresh">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>
    </button>
  </div>
</header>

<style>
  .app-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: 44px;
    padding: 0 8px 0 10px;
    border-bottom: 1px solid var(--color-panel-border);
    background: var(--color-surface);
    /* The current tool's colour runs along the bottom edge. */
    box-shadow: inset 0 -2px 0 var(--color-accent);
  }
  .mark {
    width: 18px;
    height: 12px;
    margin-right: 2px;
    border-radius: 3px;
    background:
      linear-gradient(#fff, #fff) 4px 6px / 10px 2px no-repeat,
      linear-gradient(#fff, #fff) 6px 3px / 6px 2px no-repeat,
      #ffb547;
  }
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
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
  .seq-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 170px;
    padding: 3px 9px 3px 8px;
    border-radius: 999px;
    background: var(--color-surface-raised);
    color: var(--color-panel-text);
    font-size: 11.5px;
  }
  .seq-chip .dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--color-success);
    flex-shrink: 0;
  }
  .seq-chip.none {
    color: var(--color-panel-secondary);
  }
  .seq-chip.none .dot {
    background: var(--color-panel-secondary);
  }
</style>
