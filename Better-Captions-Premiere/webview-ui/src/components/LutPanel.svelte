<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { applyLut, parseCube, type Lut } from "../lib/lut";
  import { toolStatus } from "../lib/toolStatus.svelte";

  interface Props {
    hostApi: any;
  }

  let { hostApi }: Props = $props();

  interface LutFile {
    name: string;
    path: string;
    folder: string;
  }
  interface LutRoot {
    id: string;
    label: string;
    path: string;
    custom: boolean;
    luts: LutFile[];
  }

  const THUMB_W = 192;
  const THUMB_H = 108;
  const MAX_RESULTS = 120;

  // ---------- library ----------
  let roots = $state<LutRoot[]>([]);
  let scanning = $state(true);
  let rootId = $state<string | null>(null);
  let folder = $state<string>("");
  let query = $state("");
  let favoritesOnly = $state(false);
  let favorites = $state<string[]>([]);
  let customFolders = $state<string[]>([]);

  let root = $derived(roots.find((r) => r.id === rootId) ?? roots[0] ?? null);
  let folders = $derived.by(() => {
    if (!root) return [] as { name: string; count: number }[];
    const counts = new Map<string, number>();
    for (const l of root.luts) counts.set(l.folder, (counts.get(l.folder) ?? 0) + 1);
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  });
  let totalLuts = $derived(roots.reduce((n, r) => n + r.luts.length, 0));
  // Search and favourites look across every source; otherwise show one folder.
  let shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (favoritesOnly) return roots.flatMap((r) => r.luts).filter((l) => favorites.includes(l.path) && (!q || l.name.toLowerCase().includes(q)));
    if (q) return roots.flatMap((r) => r.luts).filter((l) => l.name.toLowerCase().includes(q) || l.folder.toLowerCase().includes(q));
    return root ? root.luts.filter((l) => l.folder === folder) : [];
  });
  let visible = $derived(shown.slice(0, MAX_RESULTS));

  // ---------- frame and viewer ----------
  let frameSource = $state<"clip" | "program">("clip");
  let frameLabel = $state<string | null>(null);
  let frameId = $state(0);
  let grabbing = $state(false);
  let base: ImageData | null = null; // original frame at viewer resolution (not reactive: large)
  let hasFrame = $state(false);
  let thumbBase: ImageData | null = null; // original frame at thumbnail size
  let viewer: HTMLCanvasElement | undefined = $state();

  let intensity = $state(100);
  let compare = $state(true);
  let split = $state(0.5);
  let dragging = $state(false);

  let selected = $state<LutFile | null>(null);
  let hovered = $state<LutFile | null>(null);
  let previewing = $derived(hovered ?? selected);
  $effect(() => {
    toolStatus.lut = selected?.name ?? null;
  });

  let error = $state<string | null>(null);
  let status = $state<string | null>(null);
  let applying = $state(false);

  // ---------- LUT cache and thumbnails ----------
  const lutCache = new Map<string, Lut | Error>();
  let thumbs = $state<Record<string, string>>({});
  let thumbJob = 0;

  async function getLut(file: string): Promise<Lut> {
    let lut = lutCache.get(file);
    if (!lut) {
      try {
        lut = parseCube(await hostApi.readLutText(file));
      } catch (e: any) {
        lut = new Error(e?.message || String(e));
      }
      if (lutCache.size > 300) lutCache.delete(lutCache.keys().next().value!);
      lutCache.set(file, lut);
    }
    if (lut instanceof Error) throw lut;
    return lut;
  }

  onMount(async () => {
    const settings = await hostApi.loadLutSettings();
    favorites = settings.favorites;
    customFolders = settings.folders;
    await rescan();
    grabFrame();
  });

  onDestroy(() => {
    thumbJob++;
  });

  async function rescan() {
    scanning = true;
    try {
      roots = await hostApi.scanLutLibrary();
      if (!roots.some((r) => r.id === rootId)) rootId = roots[0]?.id ?? null;
      pickFirstFolder();
    } catch (e: any) {
      error = `Couldn't read the LUT folders: ${e?.message || e}`;
    } finally {
      scanning = false;
    }
  }

  function pickFirstFolder() {
    if (root && !folders.some((f) => f.name === folder)) folder = folders[0]?.name ?? "";
  }

  async function grabFrame() {
    grabbing = true;
    error = null;
    try {
      const res = await hostApi.grabFrame(frameSource);
      if (!res?.success) throw new Error(res?.error || "Couldn't grab the frame.");
      const blob = new Blob([res.png], { type: "image/png" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((ok, fail) => {
        img.onload = ok;
        img.onerror = () => fail(new Error("Couldn't decode the frame."));
        img.src = url;
      });
      URL.revokeObjectURL(url);

      const w = Math.min(960, img.naturalWidth);
      const h = Math.round((w / img.naturalWidth) * img.naturalHeight);
      base = drawToImageData(img, w, h);
      thumbBase = drawToImageData(img, THUMB_W, THUMB_H, true);
      frameLabel = res.label;
      hasFrame = true;
      frameId++;
      thumbs = {};
      renderViewer();
    } catch (e: any) {
      error = e?.message || String(e);
    } finally {
      grabbing = false;
    }
  }

  // `cover` crops to fill the box (thumbnails); otherwise scales to fit.
  function drawToImageData(img: HTMLImageElement, w: number, h: number, cover = false) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    if (cover) {
      const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
      const dw = img.naturalWidth * s;
      const dh = img.naturalHeight * s;
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    } else {
      ctx.drawImage(img, 0, 0, w, h);
    }
    return ctx.getImageData(0, 0, w, h);
  }

  // Draws the frame with the previewed LUT; in compare mode the left side stays original.
  let renderToken = 0;
  async function renderViewer() {
    const token = ++renderToken;
    if (!viewer || !base) return;
    const out = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
    if (previewing) {
      try {
        const lut = await getLut(previewing.path);
        if (token !== renderToken) return;
        applyLut(out.data, lut, intensity / 100);
        if (compare) {
          const cut = Math.round(base.width * split);
          for (let y = 0; y < base.height; y++) {
            const row = y * base.width * 4;
            out.data.set(base.data.subarray(row, row + cut * 4), row);
          }
        }
      } catch (e: any) {
        if (token === renderToken) error = `${previewing.name}: ${e?.message || e}`;
      }
    }
    viewer.width = base.width;
    viewer.height = base.height;
    viewer.getContext("2d")!.putImageData(out, 0, 0);
  }

  $effect(() => {
    // Redraw when the previewed LUT, intensity or split changes.
    previewing;
    intensity;
    compare;
    split;
    frameId;
    renderViewer();
  });

  // Thumbnails for the visible LUTs, a few at a time so the panel stays responsive.
  $effect(() => {
    const list = visible;
    const id = frameId;
    const job = ++thumbJob;
    if (!thumbBase || !list.length) return;
    (async () => {
      const canvas = document.createElement("canvas");
      canvas.width = THUMB_W;
      canvas.height = THUMB_H;
      const ctx = canvas.getContext("2d")!;
      for (let i = 0; i < list.length; i++) {
        if (job !== thumbJob || id !== frameId) return;
        const lut = list[i];
        const key = `${id}|${lut.path}`;
        if (thumbs[key]) continue;
        try {
          const pixels = new ImageData(new Uint8ClampedArray(thumbBase!.data), THUMB_W, THUMB_H);
          applyLut(pixels.data, await getLut(lut.path), 1);
          ctx.putImageData(pixels, 0, 0);
          thumbs[key] = canvas.toDataURL("image/jpeg", 0.85);
        } catch {
          thumbs[key] = "error";
        }
        if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
      }
    })();
  });

  // ---------- split handle ----------
  function onSplitPointer(e: PointerEvent) {
    if (!viewer || !compare) return;
    const rect = viewer.getBoundingClientRect();
    split = Math.min(0.98, Math.max(0.02, (e.clientX - rect.left) / rect.width));
  }

  // ---------- actions ----------
  async function toggleFavorite(lut: LutFile) {
    favorites = favorites.includes(lut.path) ? favorites.filter((f) => f !== lut.path) : [...favorites, lut.path];
    await hostApi.saveLutSettings({ folders: customFolders, favorites: $state.snapshot(favorites) });
  }

  async function addFolder() {
    const res = await hostApi.addLutFolder();
    if (!res?.success) return;
    customFolders = [...customFolders, res.folder];
    await rescan();
    const added = roots.find((r) => r.path === res.folder);
    if (added) {
      rootId = added.id;
      pickFirstFolder();
    }
  }

  async function removeFolder(r: LutRoot) {
    await hostApi.removeLutFolder(r.path);
    customFolders = customFolders.filter((f) => f !== r.path);
    await rescan();
  }

  function copyPath(file: string) {
    const area = document.createElement("textarea");
    area.value = file;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }

  async function applyToClips() {
    if (!selected || applying) return;
    applying = true;
    error = null;
    status = null;
    try {
      const res = await hostApi.applyLutToSelection(selected.path);
      if (!res?.success) throw new Error(res?.error || "Couldn't apply the LUT.");
      if (res.lookSet === res.clips) {
        status = `Applied "${selected.name}" to ${res.clips} clip${res.clips === 1 ? "" : "s"} (Lumetri Color > Look).`;
      } else {
        const copied = copyPath(selected.path);
        status =
          `${res.lumetriAdded ? "Added Lumetri Color to the clip. " : ""}Premiere doesn't let extensions set the LUT itself, ` +
          `so finish in one step: in Lumetri Color > Creative > Look, choose Browse and paste the path` +
          (copied ? " (copied)." : ".");
      }
    } catch (e: any) {
      error = e?.message || String(e);
    } finally {
      applying = false;
    }
  }

  const folderLabel = (name: string) => name || "(top folder)";
</script>

<div class="flex flex-col gap-3 px-3 py-3">
  <!-- Viewer -->
  <div class="space-y-2">
    <div
      class="lut-viewer relative rounded-lg overflow-hidden bg-black select-none"
      class:cursor-ew-resize={compare && !!previewing}
      onpointerdown={(e) => {
        if (!compare || !previewing) return;
        dragging = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        onSplitPointer(e);
      }}
      onpointermove={(e) => dragging && onSplitPointer(e)}
      onpointerup={() => (dragging = false)}
      role="presentation"
    >
      <canvas bind:this={viewer} class="block w-full h-auto" style="aspect-ratio:16/9;object-fit:contain"></canvas>
      {#if !hasFrame}
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6">
          <p class="text-[13px] text-panel-text">{grabbing ? "Grabbing the frame…" : "No frame yet"}</p>
          <p class="text-[12px] text-panel-secondary">Move the playhead over a clip, then grab a frame to preview LUTs on it.</p>
        </div>
      {/if}
      {#if hasFrame && previewing && compare}
        <div class="absolute inset-y-0 w-px bg-white/80 pointer-events-none" style="left:{split * 100}%">
          <div class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-8 rounded-full bg-white/90 shadow flex items-center justify-center gap-0.5">
            <span class="w-px h-3.5 bg-black/60"></span><span class="w-px h-3.5 bg-black/60"></span>
          </div>
        </div>
        <span class="viewer-tag left-2">Original</span>
        <span class="viewer-tag right-2 max-w-[60%] truncate">{previewing.name}</span>
      {:else if hasFrame && previewing}
        <span class="viewer-tag right-2 max-w-[70%] truncate">{previewing.name}</span>
      {/if}
    </div>

    <div class="flex items-center gap-2">
      <div class="seg">
        <button class:on={frameSource === "clip"} onclick={() => { frameSource = "clip"; grabFrame(); }} title="The clip's own image, before any grading">Clip</button>
        <button class:on={frameSource === "program"} onclick={() => { frameSource = "program"; grabFrame(); }} title="What the Program monitor shows, with effects">Program</button>
      </div>
      <button class="btn-quiet" onclick={grabFrame} disabled={grabbing}>{grabbing ? "Grabbing…" : "Grab frame"}</button>
      <span class="text-[11.5px] text-panel-secondary truncate flex-1 text-right" title={frameLabel ?? ""}>{frameLabel ?? ""}</span>
    </div>

    <div class="flex items-center gap-3">
      <label class="flex items-center gap-2 flex-1">
        <span class="text-[12px] text-panel-secondary w-16 shrink-0">Intensity</span>
        <input type="range" min="0" max="100" step="1" bind:value={intensity} class="flex-1 accent-accent" />
        <span class="font-display text-[13px] text-panel-text w-10 text-right tabular-nums">{intensity}%</span>
      </label>
      <label class="flex items-center gap-1.5 cursor-pointer shrink-0">
        <input type="checkbox" bind:checked={compare} class="accent-accent" />
        <span class="text-[12px] text-panel-text">Compare</span>
      </label>
    </div>
  </div>

  <!-- Library -->
  <div class="space-y-2">
    <div class="flex items-baseline justify-between">
      <h2 class="font-display text-[15px] text-panel-text">Library</h2>
      <span class="text-[11.5px] text-panel-secondary">{scanning ? "Reading LUT folders…" : `${totalLuts.toLocaleString()} LUTs`}</span>
    </div>

    <div class="flex flex-wrap gap-1.5">
      {#each roots as r (r.id)}
        <button
          class="chip"
          class:on={!query && !favoritesOnly && root?.id === r.id}
          onclick={() => { rootId = r.id; query = ""; favoritesOnly = false; pickFirstFolder(); }}
          title={r.path}
        >
          {r.label} <span class="opacity-60">{r.luts.length}</span>
        </button>
      {/each}
      <button class="chip" class:on={favoritesOnly} onclick={() => (favoritesOnly = !favoritesOnly)}>★ Favourites <span class="opacity-60">{favorites.length}</span></button>
      <button class="chip chip-add" onclick={addFolder}>+ Add folder</button>
    </div>

    <div class="flex gap-2">
      <input
        bind:value={query}
        placeholder="Search all LUTs"
        class="flex-1 min-w-0 bg-surface-raised text-panel-text text-[12.5px] px-2.5 py-1.5 rounded-md border border-panel-border focus:border-accent outline-none"
      />
      {#if !query && !favoritesOnly && root}
        <select
          bind:value={folder}
          class="w-[48%] bg-surface-raised text-panel-text text-[12.5px] px-2 py-1.5 rounded-md border border-panel-border outline-none"
          title="Folder"
        >
          {#each folders as f (f.name)}
            <option value={f.name}>{folderLabel(f.name)} ({f.count})</option>
          {/each}
        </select>
      {/if}
    </div>
    {#if root?.custom && !query && !favoritesOnly}
      <button class="text-[11.5px] text-panel-secondary hover:text-panel-text bg-transparent border-none cursor-pointer p-0" onclick={() => removeFolder(root!)}>
        Remove "{root.label}" from the library
      </button>
    {/if}

    {#if !scanning && !shown.length}
      <p class="text-[12px] text-panel-secondary py-3">
        {favoritesOnly ? "No favourites yet. Hover a LUT and click its star." : query ? `No LUTs match "${query}".` : "This folder has no .cube LUTs."}
      </p>
    {/if}

    <div class="grid grid-cols-2 gap-2">
      {#each visible as lut (lut.path)}
        {@const key = `${frameId}|${lut.path}`}
        <div
          class="lut-card group"
          class:picked={selected?.path === lut.path}
          onmouseenter={() => (hovered = lut)}
          onmouseleave={() => (hovered = null)}
          role="presentation"
        >
          <button class="block w-full p-0 border-none bg-transparent cursor-pointer text-left" onclick={() => (selected = lut)} title={lut.path}>
            <div class="relative rounded overflow-hidden bg-surface" style="aspect-ratio:16/9">
              {#if thumbs[key] && thumbs[key] !== "error"}
                <img src={thumbs[key]} alt="" class="block w-full h-full object-cover" />
              {:else if thumbs[key] === "error"}
                <div class="absolute inset-0 flex items-center justify-center text-[11px] text-panel-secondary px-2 text-center">Can't read this LUT</div>
              {:else if hasFrame}
                <div class="absolute inset-0 thumb-loading"></div>
              {/if}
            </div>
            <div class="px-0.5 pt-1">
              <div class="text-[12px] text-panel-text truncate">{lut.name}</div>
              {#if query || favoritesOnly}<div class="text-[10.5px] text-panel-secondary truncate">{folderLabel(lut.folder)}</div>{/if}
            </div>
          </button>
          <button
            class="star"
            class:starred={favorites.includes(lut.path)}
            onclick={() => toggleFavorite(lut)}
            aria-label={favorites.includes(lut.path) ? "Remove from favourites" : "Add to favourites"}
          >★</button>
        </div>
      {/each}
    </div>
    {#if shown.length > MAX_RESULTS}
      <p class="text-[11.5px] text-panel-secondary">Showing {MAX_RESULTS} of {shown.length}. Search or pick a folder to narrow it down.</p>
    {/if}
  </div>

  {#if error}
    <p class="text-[12px] text-red-400 break-words">{error}</p>
  {/if}
</div>

{#if selected}
  <!-- Chosen LUT -->
  <div class="sticky bottom-0 border-t border-panel-border bg-surface px-3 py-2.5 space-y-2">
    <div class="flex items-baseline justify-between gap-2">
      <span class="font-display text-[14px] text-panel-text truncate" title={selected.path}>{selected.name}</span>
      <span class="text-[11px] text-panel-secondary truncate">{folderLabel(selected.folder)}</span>
    </div>
    <button class="btn-primary w-full" onclick={applyToClips} disabled={applying}>
      {applying ? "Applying…" : "Apply to selected clips"}
    </button>
    <div class="flex gap-3">
      <button class="link" onclick={() => (copyPath(selected!.path) ? (status = "Path copied.") : (error = "Couldn't copy the path."))}>Copy path</button>
      <button class="link" onclick={() => hostApi.revealInFolder(selected!.path)}>Show in folder</button>
    </div>
    {#if status}
      <p class="text-[12px] text-success break-words">{status}</p>
    {/if}
  </div>
{/if}

<style>
  .viewer-tag {
    position: absolute;
    top: 0.5rem;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    color: #fff;
    background: rgba(0, 0, 0, 0.55);
    pointer-events: none;
  }
  .lut-card {
    position: relative;
    padding: 4px;
    border-radius: 8px;
    border: 1px solid transparent;
    transition: border-color 120ms, background 120ms;
  }
  .lut-card:hover {
    background: var(--color-surface-raised);
  }
  .lut-card.picked {
    border-color: var(--color-accent);
    background: var(--color-accent-soft);
  }
  .star {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    border: none;
    background: rgba(0, 0, 0, 0.55);
    color: rgba(255, 255, 255, 0.85);
    font-size: 12px;
    line-height: 22px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 120ms;
  }
  .lut-card:hover .star,
  .star:focus-visible,
  .star.starred {
    opacity: 1;
  }
  .star.starred {
    color: var(--color-accent);
  }
  .thumb-loading {
    background: linear-gradient(90deg, var(--color-surface) 0%, var(--color-surface-raised) 50%, var(--color-surface) 100%);
    background-size: 200% 100%;
    animation: thumb-shimmer 1.2s linear infinite;
  }
  @keyframes thumb-shimmer {
    to {
      background-position: -200% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .thumb-loading {
      animation: none;
    }
  }
</style>
