<script lang="ts">
  import type { Component } from "svelte";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  interface Props {
    title: string;
    icon: Component<any>;
    open: boolean;
    onToggle: () => void;
  }

  let { title, icon: Icon, open, onToggle }: Props = $props();
</script>

<button class="section-header" onclick={onToggle} aria-expanded={open}>
  <span class="icon"><Icon size={14} strokeWidth={1.75} /></span>
  <span class="title">{title}</span>
  <span class="chev" class:open><ChevronDown size={14} strokeWidth={1.75} /></span>
</button>

<style>
  .section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 32px;
    padding: 0 10px 0 12px;
    border: none;
    background: transparent;
    color: var(--color-panel-text);
    font-size: 12px;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }
  .section-header:hover {
    background: var(--color-surface);
  }
  .section-header:focus-visible {
    outline-offset: -2px;
  }
  .icon {
    display: flex;
    color: var(--color-panel-secondary);
  }
  .title {
    flex: 1;
  }
  .chev {
    display: flex;
    color: var(--color-panel-tertiary);
    transition: transform 120ms;
    transform: rotate(-90deg);
  }
  .chev.open {
    transform: none;
  }
</style>
