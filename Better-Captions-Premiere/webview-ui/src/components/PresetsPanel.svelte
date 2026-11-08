<script lang="ts">
  import { onMount } from "svelte";
  import type { AnimationConfig, StyleConfig } from "../lib/types";
  import {
    BUILT_IN_PRESETS,
    loadUserPresets,
    lookFromPreset,
    parsePresets,
    presetFromLook,
    saveUserPresets,
    serializePresets,
    type CaptionPreset,
  } from "../lib/presets";
  import PresetThumb from "./PresetThumb.svelte";

  interface Props {
    style: StyleConfig;
    animation: AnimationConfig;
    onApply: (look: { style: Partial<StyleConfig>; animation: Partial<AnimationConfig> }) => void;
    hostApi: any;
  }

  let { style, animation, onApply, hostApi }: Props = $props();

  let isOpen = $state(true);
  let userPresets = $state<CaptionPreset[]>([]);
  let naming = $state<string | null>(null); // name typed for a new preset
  let menuFor = $state<string | null>(null);
  let renaming = $state<{ id: string; name: string } | null>(null);
  let confirmDelete = $state<string | null>(null);
  let status = $state<string | null>(null);
  let error = $state<string | null>(null);
  let fileInput: HTMLInputElement | undefined = $state();

  onMount(() => {
    userPresets = loadUserPresets();
  });

  function persist(next: CaptionPreset[]) {
    try {
      saveUserPresets(next);
      userPresets = next;
      return true;
    } catch (e: any) {
      error = `Couldn't save presets: ${e?.message || e}`;
      return false;
    }
  }

  function flash(message: string) {
    error = null;
    status = message;
    setTimeout(() => {
      if (status === message) status = null;
    }, 4000);
  }

  function apply(preset: CaptionPreset) {
    onApply(lookFromPreset(preset));
    menuFor = null;
    flash(`Applied "${preset.name}".`);
  }

  function saveCurrent() {
    const name = (naming ?? "").trim();
    if (!name) return;
    const preset = presetFromLook(name, $state.snapshot(style), $state.snapshot(animation));
    if (persist([preset, ...userPresets])) flash(`Saved "${preset.name}". It's available in every project.`);
    naming = null;
  }

  function updateWithCurrent(preset: CaptionPreset) {
    const fresh = presetFromLook(preset.name, $state.snapshot(style), $state.snapshot(animation));
    if (persist(userPresets.map((p) => (p.id === preset.id ? { ...fresh, id: p.id, createdAt: p.createdAt } : p)))) {
      flash(`Updated "${preset.name}" with the current look.`);
    }
    menuFor = null;
  }

  function finishRename() {
    if (!renaming) return;
    const { id, name } = renaming;
    if (name.trim()) persist(userPresets.map((p) => (p.id === id ? { ...p, name: name.trim().slice(0, 80) } : p)));
    renaming = null;
  }

  function remove(preset: CaptionPreset) {
    if (persist(userPresets.filter((p) => p.id !== preset.id))) flash(`Deleted "${preset.name}".`);
    confirmDelete = null;
    menuFor = null;
  }

  const fileName = (name: string) => `${name.replace(/[\\/:*?"<>|]/g, "_").trim() || "presets"}.bcpreset`;

  async function exportPresets(list: CaptionPreset[], name: string) {
    menuFor = null;
    const res = await hostApi.saveTextFile(fileName(name), "bcpreset", serializePresets(list));
    if (res?.cancelled) return;
    if (!res?.success) error = res?.error || "Couldn't save the preset file.";
    else flash(`Exported to ${res.path}. Import it on any computer with Better Captions.`);
  }

  function importText(text: string) {
    try {
      const imported = parsePresets(text, true);
      if (!imported.length) throw new Error("No presets found in that file.");
      if (persist([...imported, ...userPresets])) {
        flash(`Imported ${imported.length} preset${imported.length === 1 ? "" : "s"}.`);
      }
    } catch (e: any) {
      error = `Couldn't import presets: ${e?.message || e}`;
    }
  }

  async function importPresets() {
    error = null;
    const cepFs = (window as any).cep?.fs;
    if (cepFs?.showOpenDialogEx) {
      const res = cepFs.showOpenDialogEx(false, false, "Import presets", "", ["bcpreset", "json"]);
      const picked = res && !res.err && res.data?.[0];
      if (!picked) return;
      const nodeRequire = (window as any).cep_node?.require ?? (window as any).require;
      importText(nodeRequire("fs").readFileSync(picked, "utf8"));
    } else {
      fileInput?.click();
    }
  }
</script>

{#snippet card(preset: CaptionPreset)}
  <div class="relative rounded-md border border-panel-border bg-surface-raised p-1.5 hover:border-accent transition-colors">
    <button onclick={() => apply(preset)} class="w-full border-none bg-transparent p-0 cursor-pointer text-left" title="Apply {preset.name}">
      <PresetThumb {preset} />
    </button>
    <div class="flex items-center justify-between gap-1 mt-1">
      {#if renaming?.id === preset.id}
        <input
          bind:value={renaming.name}
          onkeydown={(e) => { if (e.key === "Enter") finishRename(); if (e.key === "Escape") renaming = null; }}
          onblur={finishRename}
          class="flex-1 min-w-0 bg-surface text-panel-text text-[12px] px-1 py-0.5 rounded border border-accent outline-none"
        />
      {:else}
        <span class="text-[12px] text-panel-text truncate" title={preset.name}>{preset.name}</span>
      {/if}
      {#if !preset.builtIn}
        <button
          onclick={() => (menuFor = menuFor === preset.id ? null : preset.id)}
          class="shrink-0 px-1 text-[14px] leading-none text-panel-secondary hover:text-panel-text bg-transparent border-none cursor-pointer"
          aria-label="Preset options"
        >
          ⋯
        </button>
      {/if}
    </div>
    {#if menuFor === preset.id}
      <div class="absolute z-20 right-1 top-full mt-1 w-[170px] rounded-md border border-panel-border bg-surface shadow-lg py-1">
        {#if confirmDelete === preset.id}
          <div class="px-2 py-1 text-[12px] text-panel-text">Delete "{preset.name}"?</div>
          <div class="flex gap-1 px-2 pb-1">
            <button onclick={() => remove(preset)} class="flex-1 py-1 rounded text-[12px] border-none cursor-pointer bg-red-500 text-white">Delete</button>
            <button onclick={() => (confirmDelete = null)} class="flex-1 py-1 rounded text-[12px] border border-panel-border cursor-pointer bg-surface-raised text-panel-text">Keep</button>
          </div>
        {:else}
          {#each [
            { label: "Rename", run: () => { renaming = { id: preset.id, name: preset.name }; menuFor = null; } },
            { label: "Update to current look", run: () => updateWithCurrent(preset) },
            { label: "Export…", run: () => exportPresets([preset], preset.name) },
            { label: "Delete", run: () => (confirmDelete = preset.id) },
          ] as item}
            <button
              onclick={item.run}
              class="w-full text-left px-2 py-1 text-[12px] text-panel-text bg-transparent border-none cursor-pointer hover:bg-panel-hover-bg"
            >
              {item.label}
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<div class="border-b border-panel-border">
  <button
    onclick={() => (isOpen = !isOpen)}
    class="w-full px-3 py-2 flex items-center justify-between text-[12.5px] font-semibold text-panel-text bg-surface hover:bg-panel-hover-bg transition-colors cursor-pointer border-none"
  >
    <span>Presets</span>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="transition-transform" class:rotate-180={isOpen}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  </button>

  {#if isOpen}
    <div class="px-3 py-2.5 space-y-2.5">
      {#if naming !== null}
        <div class="flex gap-1.5">
          <!-- svelte-ignore a11y_autofocus -->
          <input
            bind:value={naming}
            autofocus
            placeholder="Preset name"
            maxlength="80"
            onkeydown={(e) => { if (e.key === "Enter") saveCurrent(); if (e.key === "Escape") naming = null; }}
            class="flex-1 min-w-0 bg-surface-raised text-panel-text text-[12px] px-2 py-1.5 rounded border border-accent outline-none"
          />
          <button onclick={saveCurrent} disabled={!naming.trim()} class="px-3 rounded text-[12px] font-semibold border-none cursor-pointer bg-accent text-accent-ink disabled:opacity-50">Save</button>
          <button onclick={() => (naming = null)} class="px-2 rounded text-[12px] border border-panel-border cursor-pointer bg-surface-raised text-panel-text">Cancel</button>
        </div>
      {:else}
        <div class="flex gap-1.5">
          <button
            onclick={() => (naming = "")}
            class="flex-1 py-1.5 rounded text-[12px] font-semibold border-none cursor-pointer bg-accent hover:bg-accent-hover text-accent-ink"
          >
            + Save current look
          </button>
          <button onclick={importPresets} class="px-2.5 py-1.5 rounded text-[12px] border border-panel-border cursor-pointer bg-surface-raised text-panel-text hover:bg-panel-hover-bg">Import…</button>
          {#if userPresets.length}
            <button onclick={() => exportPresets(userPresets, "Better Captions presets")} class="px-2.5 py-1.5 rounded text-[12px] border border-panel-border cursor-pointer bg-surface-raised text-panel-text hover:bg-panel-hover-bg">Export all…</button>
          {/if}
        </div>
      {/if}
      <input
        bind:this={fileInput}
        type="file"
        accept=".bcpreset,.json"
        class="hidden"
        onchange={async (e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (f) importText(await f.text());
          (e.target as HTMLInputElement).value = "";
        }}
      />

      {#if userPresets.length}
        <div class="text-[11.5px] font-medium text-panel-secondary">My presets</div>
        <div class="grid grid-cols-2 gap-2">
          {#each userPresets as preset (preset.id)}
            {@render card(preset)}
          {/each}
        </div>
      {/if}

      <div class="text-[11.5px] font-medium text-panel-secondary">Built-in</div>
      <div class="grid grid-cols-2 gap-2">
        {#each BUILT_IN_PRESETS as preset (preset.id)}
          {@render card(preset)}
        {/each}
      </div>

      {#if error}
        <p class="text-[12px] text-red-400 break-words">{error}</p>
      {/if}
      {#if status}
        <p class="text-[12px] text-green-400 break-words">{status}</p>
      {/if}
    </div>
  {/if}
</div>
