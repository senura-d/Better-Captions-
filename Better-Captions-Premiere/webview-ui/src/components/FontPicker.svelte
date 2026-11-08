<script lang="ts">
  import { onMount } from "svelte";
  import { addFontFile, canAddFontFiles, getFonts, type FontList } from "../lib/fonts";

  interface Props {
    value: string;
    onChange: (family: string) => void;
  }

  let { value, onChange }: Props = $props();

  let fonts = $state<FontList>({ installed: [], added: [] });
  let loading = $state(true);
  let open = $state(false);
  let query = $state("");
  let error = $state<string | null>(null);
  let searchEl: HTMLInputElement | undefined = $state();
  let rootEl: HTMLDivElement | undefined = $state();

  // Rendering every name in its own font is costly, so cap the visible list.
  const MAX_SHOWN = 150;

  onMount(async () => {
    fonts = await getFonts();
    loading = false;
  });

  const matches = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());
  let added = $derived(fonts.added.filter(matches));
  let installed = $derived(fonts.installed.filter(matches));
  let total = $derived(fonts.added.length + fonts.installed.length);

  function toggle() {
    open = !open;
    if (open) {
      query = "";
      setTimeout(() => searchEl?.focus(), 0);
    }
  }

  function pick(family: string) {
    onChange(family);
    open = false;
  }

  async function addFile() {
    error = null;
    const res = await addFontFile();
    if (res.cancelled) return;
    if (!res.success || !res.family) {
      error = res.error || "That font couldn't be added.";
      return;
    }
    fonts = await getFonts(true);
    pick(res.family);
  }

  function onWindowClick(e: MouseEvent) {
    if (open && rootEl && !rootEl.contains(e.target as Node)) open = false;
  }
</script>

<svelte:window onclick={onWindowClick} />

<div class="relative" bind:this={rootEl}>
  <button
    onclick={toggle}
    class="w-full flex items-center justify-between gap-2 bg-surface-raised text-panel-text px-2 py-1.5 rounded border border-panel-border hover:border-accent cursor-pointer text-left"
    title={value}
  >
    <span class="truncate text-[15px]" style="font-family:&quot;{value}&quot;, sans-serif">{value}</span>
    <span class="text-[11px] text-panel-secondary shrink-0">{loading ? "Loading fonts…" : `${total} fonts`}</span>
  </button>

  {#if open}
    <div class="absolute z-30 left-0 right-0 mt-1 rounded-md border border-panel-border bg-surface shadow-lg">
      <input
        bind:this={searchEl}
        bind:value={query}
        placeholder="Search fonts…"
        class="w-full bg-surface-raised text-panel-text text-[13px] px-2 py-1.5 border-0 border-b border-panel-border outline-none rounded-t-md"
        onkeydown={(e) => {
          if (e.key === "Escape") open = false;
          if (e.key === "Enter" && (added[0] || installed[0])) pick(added[0] || installed[0]);
        }}
      />
      <div class="max-h-[260px] overflow-y-auto py-1">
        {#if added.length}
          <div class="px-2 pt-1 pb-0.5 text-[11.5px] font-medium text-panel-secondary">Your added fonts</div>
          {#each added as family (family)}
            <button
              onclick={() => pick(family)}
              class="w-full text-left px-2 py-1 hover:bg-panel-hover-bg cursor-pointer border-none bg-transparent flex items-baseline justify-between gap-2"
              class:text-accent={family === value}
              class:text-panel-text={family !== value}
            >
              <span class="truncate text-[15px]" style="font-family:&quot;{family}&quot;, sans-serif">{family}</span>
            </button>
          {/each}
        {/if}
        <div class="px-2 pt-1 pb-0.5 text-[11.5px] font-medium text-panel-secondary">Installed fonts</div>
        {#each installed.slice(0, MAX_SHOWN) as family (family)}
          <button
            onclick={() => pick(family)}
            class="w-full text-left px-2 py-1 hover:bg-panel-hover-bg cursor-pointer border-none bg-transparent flex items-baseline justify-between gap-2"
            class:text-accent={family === value}
            class:text-panel-text={family !== value}
          >
            <span class="truncate text-[15px]" style="font-family:&quot;{family}&quot;, sans-serif">{family}</span>
            <span class="text-[10px] text-panel-secondary shrink-0" style="font-family:&quot;{family}&quot;, sans-serif">Preview</span>
          </button>
        {/each}
        {#if installed.length > MAX_SHOWN}
          <div class="px-2 py-1 text-[11px] text-panel-secondary">{installed.length - MAX_SHOWN} more — type to search</div>
        {/if}
        {#if !added.length && !installed.length}
          <div class="px-2 py-2 text-[12px] text-panel-secondary">No fonts match "{query}".</div>
        {/if}
      </div>
      {#if canAddFontFiles()}
        <div class="border-t border-panel-border p-1.5">
          <button
            onclick={addFile}
            class="w-full py-1.5 rounded text-[12px] border border-panel-border bg-surface-raised text-panel-text cursor-pointer hover:bg-panel-hover-bg"
          >
            Add font file… (.ttf / .otf)
          </button>
        </div>
      {/if}
    </div>
  {/if}
  {#if error}
    <p class="text-[11px] text-red-400 mt-1">{error}</p>
  {/if}
</div>
