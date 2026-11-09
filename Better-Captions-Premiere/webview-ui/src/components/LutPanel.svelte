<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import Star from "@lucide/svelte/icons/star";
  import Search from "@lucide/svelte/icons/search";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Film from "@lucide/svelte/icons/film";
  import Check from "@lucide/svelte/icons/check";
  import Undo2 from "@lucide/svelte/icons/undo-2";
  import Copy from "@lucide/svelte/icons/copy";
  import X from "@lucide/svelte/icons/x";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import SquareSplitHorizontal from "@lucide/svelte/icons/square-split-horizontal";
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
  interface Target {
    clips: { name: string; track: number; lumetri: boolean }[];
    fromSelection: boolean;
    underPlayhead: boolean;
    version: string;
  }

  const THUMB_W = 192;
  const THUMB_H = 108;
  const MAX_RESULTS = 120;

  const readPref = (key: string, fallback: string) => {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const writePref = (key: string, value: string | null) => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {}
  };

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

  // ---------- the clip on the timeline ----------
  // Live: picking a LUT puts it on the clip right away, so the Program monitor
  // shows the real result. Keep leaves it there; Undo puts the clip back.
  let live = $state(readPref("bc-lut-live", "1") === "1");
  let target = $state<Target | null>(null);
  let targetError = $state<string | null>(null);
  let onClip = $state<{ lut: LutFile; clips: number; checked: boolean } | null>(null);
  let clipBusy = $state(false);
  let pending: LutFile | null = null;
  // Which way of setting the LUT works in this Premiere version (see bc_writeLut):
  // null = not found out yet, -1 = none does.
  let strategy = $state<number | null>(null);
  let unsupported = $derived(strategy === -1);

  const strategyKey = () => `bc-lut-strategy-${target?.version ?? "unknown"}`;
  function loadStrategy() {
    const v = readPref(strategyKey(), "");
    strategy = v === "" ? null : Number(v);
  }
  function saveStrategy(v: number | null) {
    strategy = v;
    writePref(strategyKey(), v === null ? null : String(v));
  }

  let targetLabel = $derived.by(() => {
    if (!target || !target.clips.length) return null;
    const first = target.clips[0];
    const more = target.clips.length > 1 ? ` and ${target.clips.length - 1} more` : "";
    return `${first.name}${more}`;
  });

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

  let poll: ReturnType<typeof setInterval> | undefined;

  onMount(async () => {
    const settings = await hostApi.loadLutSettings();
    favorites = settings.favorites;
    customFolders = settings.folders;
    await refreshTarget();
    loadStrategy();
    // Follow the timeline selection while the panel is open.
    poll = setInterval(() => {
      if (!clipBusy && !document.hidden) refreshTarget();
    }, 1500);
    await rescan();
    grabFrame();
  });

  onDestroy(() => {
    thumbJob++;
    clearInterval(poll);
  });

  async function refreshTarget() {
    try {
      const res = await hostApi.getLutTarget();
      if (!res?.success) {
        target = null;
        targetError = res?.error ?? null;
        return;
      }
      const versionChanged = target?.version !== res.version;
      target = res;
      targetError = null;
      if (versionChanged) loadStrategy();
    } catch (e: any) {
      target = null;
      targetError = e?.message || String(e);
    }
  }

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

  async function decodePng(png: Uint8Array) {
    const url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
    const img = new Image();
    try {
      await new Promise((ok, fail) => {
        img.onload = ok;
        img.onerror = () => fail(new Error("Couldn't decode the frame."));
        img.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
    return img;
  }

  async function grabFrame() {
    grabbing = true;
    error = null;
    try {
      const res = await hostApi.grabFrame(frameSource);
      if (!res?.success) throw new Error(res?.error || "Couldn't grab the frame.");
      const img = await decodePng(res.png);
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
      refreshTarget();
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

  // ---------- library actions ----------
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

  function copyText(text: string) {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }

  // ---------- LUT on the clip ----------
  function pick(lut: LutFile) {
    selected = lut;
    status = null;
    if (live) putOnClip(lut);
  }

  function setLive(on: boolean) {
    live = on;
    writePref("bc-lut-live", on ? "1" : "0");
    if (on && selected && !onClip) putOnClip(selected);
  }

  // The Program monitor frame, small, for checking whether the LUT took.
  async function programPixels() {
    const res = await hostApi.grabFrame("program");
    if (!res?.success) throw new Error(res?.error || "Couldn't read the Program monitor.");
    return drawToImageData(await decodePng(res.png), 160, 90).data;
  }

  function meanDiff(a: Uint8ClampedArray, b: Uint8ClampedArray) {
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    return sum / ((a.length / 4) * 3);
  }

  // true: the Program monitor now looks like the frame with this LUT applied.
  // null: this LUT hardly changes this frame, so it can't be told.
  function lutTook(before: Uint8ClampedArray, after: Uint8ClampedArray, lut: Lut): boolean | null {
    const expected = new Uint8ClampedArray(before);
    applyLut(expected, lut, 1);
    const lutEffect = meanDiff(before, expected);
    if (lutEffect < 1.5) return null;
    const changed = meanDiff(before, after);
    return changed > lutEffect * 0.3 && meanDiff(after, expected) < changed;
  }

  async function putOnClip(lut: LutFile) {
    if (clipBusy) {
      pending = lut; // the latest pick wins
      return;
    }
    clipBusy = true;
    error = null;
    try {
      await refreshTarget();
      if (!target?.clips.length) throw new Error(targetError || "Select a video clip in the timeline, or move the playhead over one.");
      if (strategy === null && target.underPlayhead) await findStrategy(lut);
      else await setLut(lut, strategy === null || strategy < 0 ? 0 : strategy, strategy !== null && strategy >= 0);
      if (unsupported) showManualSteps(lut);
    } catch (e: any) {
      error = e?.message || String(e);
    } finally {
      clipBusy = false;
      refreshTarget();
      if (pending) {
        const next = pending;
        pending = null;
        if (next.path !== onClip?.lut.path) putOnClip(next);
      }
    }
  }

  async function setLut(lut: LutFile, way: number, checked: boolean) {
    const res = await hostApi.setClipLut(lut.path, intensity, way);
    if (!res?.success) throw new Error(res?.error || "Couldn't set the LUT on the clip.");
    onClip = { lut, clips: res.clips, checked };
    return res;
  }

  // Tries each way of setting the LUT and keeps the one that changes the
  // Program monitor the way the LUT should. Needs the clip under the playhead.
  async function findStrategy(lut: LutFile) {
    status = "Checking how this Premiere version takes LUTs…";
    const data = await getLut(lut.path);
    const before = await programPixels();
    for (const way of [0, 1, 2, 3]) {
      const res = await hostApi.setClipLut(lut.path, 100, way);
      if (!res?.success) throw new Error(res?.error || "Couldn't set the LUT on the clip.");
      const took = lutTook(before, await programPixels(), data);
      if (took === null) {
        // Can't tell on this frame: leave the first way in place and check again next time.
        onClip = { lut, clips: res.clips, checked: false };
        if (intensity !== 100) await setLut(lut, way, false);
        status = null;
        return;
      }
      if (took) {
        saveStrategy(way);
        onClip = { lut, clips: res.clips, checked: true };
        if (intensity !== 100) await setLut(lut, way, true);
        status = null;
        return;
      }
      await hostApi.restoreClipLut();
    }
    saveStrategy(-1);
    onClip = null;
    status = null;
  }

  // Premiere won't take the LUT from a script: Lumetri Color is on the clip,
  // and the path is copied for Creative > Look > Browse.
  function showManualSteps(lut: LutFile) {
    const copied = copyText(lut.path);
    status =
      `Lumetri Color is on the clip, but this Premiere version doesn't let extensions choose its LUT. ` +
      `In Lumetri Color > Creative > Look, choose Browse and paste the path${copied ? " (copied)" : ""}.`;
  }

  async function applyNow() {
    if (selected) await putOnClip(selected);
  }

  async function keep() {
    await hostApi.keepClipLut();
    status = onClip ? `Kept "${onClip.lut.name}" on ${onClip.clips === 1 ? "the clip" : `${onClip.clips} clips`}.` : null;
    onClip = null;
  }

  async function undo() {
    const res = await hostApi.restoreClipLut();
    onClip = null;
    status = res?.success ? "Clip put back as it was." : null;
    if (!res?.success) error = res?.error || "Couldn't undo.";
  }

  async function copyDiagnostics() {
    const res = await hostApi.lumetriReport();
    if (!res?.success) {
      error = res?.error || "Couldn't read Lumetri Color.";
      return;
    }
    status = copyText(res.report) ? "Lumetri details copied. Paste them into your bug report." : "Couldn't copy.";
  }

  // Intensity follows onto the clip, a moment after the slider stops.
  let intensityTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const value = intensity;
    clearTimeout(intensityTimer);
    if (!onClip || strategy === null || strategy < 0) return;
    const lut = onClip.lut;
    intensityTimer = setTimeout(() => {
      if (!clipBusy && value === intensity) setLut(lut, strategy!, true).catch((e) => (error = e?.message || String(e)));
    }, 300);
  });

  const folderLabel = (name: string) => name || "(top folder)";
</script>

<div class="lut">
  <!-- Viewer -->
  <section class="viewer-block">
    <div
      class="viewer"
      class:splitting={compare && !!previewing}
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
      <canvas bind:this={viewer}></canvas>
      {#if !hasFrame}
        <div class="viewer-empty">
          {#if grabbing}
            <LoaderCircle size={18} strokeWidth={1.75} class="spin" />
            <p>Reading the frame…</p>
          {:else}
            <Film size={22} strokeWidth={1.5} />
            <p>Move the playhead over a clip, then grab the frame.</p>
          {/if}
        </div>
      {/if}
      {#if hasFrame && previewing && compare}
        <div class="split" style="left:{split * 100}%"><span></span></div>
        <span class="tag" style="left:8px">Original</span>
        <span class="tag tag-right">{previewing.name}</span>
      {:else if hasFrame && previewing}
        <span class="tag tag-right">{previewing.name}</span>
      {/if}
    </div>

    <div class="toolbar">
      <div class="seg" role="group" aria-label="Frame">
        <button class:on={frameSource === "clip"} onclick={() => { frameSource = "clip"; grabFrame(); }} title="The clip's own image, before any grading">Clip</button>
        <button class:on={frameSource === "program"} onclick={() => { frameSource = "program"; grabFrame(); }} title="What the Program monitor shows, with effects">Program</button>
      </div>
      <button class="icon-btn" onclick={grabFrame} disabled={grabbing} title="Grab the frame at the playhead" aria-label="Grab the frame at the playhead">
        <RefreshCw size={14} strokeWidth={1.75} class={grabbing ? "spin" : ""} />
      </button>
      <span class="frame-label" title={frameLabel ?? ""}>{frameLabel ?? ""}</span>
      <button class="icon-btn" class:active={compare} onclick={() => (compare = !compare)} aria-pressed={compare} title="Compare with the original" aria-label="Compare with the original">
        <SquareSplitHorizontal size={14} strokeWidth={1.75} />
      </button>
    </div>

    <label class="slider">
      <span>Intensity</span>
      <input type="range" min="0" max="100" step="1" bind:value={intensity} />
      <span class="num">{intensity}%</span>
    </label>
  </section>

  <!-- Clip on the timeline -->
  <section class="clip-row" class:none={!targetLabel}>
    <Film size={14} strokeWidth={1.75} />
    <div class="clip-text">
      {#if targetLabel}
        <span class="clip-name" title={targetLabel}>{targetLabel}</span>
        <span class="clip-sub">{target?.fromSelection ? "Selected in the timeline" : `Under the playhead, V${target?.clips[0].track}`}</span>
      {:else}
        <span class="clip-name">No clip</span>
        <span class="clip-sub">Select a clip, or move the playhead over one</span>
      {/if}
    </div>
    <label class="switch" title="Put the LUT you pick on the clip right away">
      <input type="checkbox" checked={live} onchange={(e) => setLive(e.currentTarget.checked)} />
      <span class="track"><span class="knob"></span></span>
      <span class="switch-label">Live on clip</span>
    </label>
  </section>

  <!-- Library -->
  <section class="library">
    <div class="lib-head">
      <h2>Library</h2>
      <span>{scanning ? "Reading LUT folders…" : `${totalLuts.toLocaleString()} LUTs`}</span>
    </div>

    <div class="chips">
      {#each roots as r (r.id)}
        <button
          class="chip"
          class:on={!query && !favoritesOnly && root?.id === r.id}
          onclick={() => { rootId = r.id; query = ""; favoritesOnly = false; pickFirstFolder(); }}
          title={r.path}
        >
          {r.label} <span class="count">{r.luts.length}</span>
        </button>
      {/each}
      <button class="chip" class:on={favoritesOnly} onclick={() => (favoritesOnly = !favoritesOnly)}>
        <Star size={12} strokeWidth={1.75} /> Favourites <span class="count">{favorites.length}</span>
      </button>
      <button class="chip chip-add" onclick={addFolder}><FolderPlus size={12} strokeWidth={1.75} /> Add folder</button>
    </div>

    <div class="filters">
      <div class="search">
        <Search size={13} strokeWidth={1.75} />
        <input bind:value={query} placeholder="Search all LUTs" aria-label="Search all LUTs" />
        {#if query}
          <button class="clear" onclick={() => (query = "")} aria-label="Clear search"><X size={12} strokeWidth={2} /></button>
        {/if}
      </div>
      {#if !query && !favoritesOnly && root}
        <select bind:value={folder} title="Folder" aria-label="Folder">
          {#each folders as f (f.name)}
            <option value={f.name}>{folderLabel(f.name)} ({f.count})</option>
          {/each}
        </select>
      {/if}
    </div>
    {#if root?.custom && !query && !favoritesOnly}
      <button class="link quiet" onclick={() => removeFolder(root!)}>Remove "{root.label}" from the library</button>
    {/if}

    {#if !scanning && !shown.length}
      <p class="empty">
        {favoritesOnly ? "No favourites yet. Hover a LUT and click its star." : query ? `No LUTs match "${query}".` : "This folder has no .cube LUTs."}
      </p>
    {/if}

    <div class="grid">
      {#each visible as lut (lut.path)}
        {@const key = `${frameId}|${lut.path}`}
        {@const starred = favorites.includes(lut.path)}
        <div
          class="card"
          class:picked={selected?.path === lut.path}
          onmouseenter={() => (hovered = lut)}
          onmouseleave={() => (hovered = null)}
          role="presentation"
        >
          <button class="card-btn" onclick={() => pick(lut)} title={lut.path}>
            <div class="thumb">
              {#if thumbs[key] && thumbs[key] !== "error"}
                <img src={thumbs[key]} alt="" />
              {:else if thumbs[key] === "error"}
                <div class="thumb-msg">Can't read this LUT</div>
              {:else if hasFrame}
                <div class="thumb-loading"></div>
              {/if}
              {#if onClip?.lut.path === lut.path}
                <span class="on-clip-badge"><Check size={11} strokeWidth={2.5} /> On clip</span>
              {/if}
            </div>
            <div class="card-name">{lut.name}</div>
            {#if query || favoritesOnly}<div class="card-folder">{folderLabel(lut.folder)}</div>{/if}
          </button>
          <button
            class="star"
            class:starred
            onclick={() => toggleFavorite(lut)}
            aria-label={starred ? "Remove from favourites" : "Add to favourites"}
            aria-pressed={starred}
          >
            <Star size={12} strokeWidth={1.75} fill={starred ? "currentColor" : "none"} />
          </button>
        </div>
      {/each}
    </div>
    {#if shown.length > MAX_RESULTS}
      <p class="empty">Showing {MAX_RESULTS} of {shown.length}. Search or pick a folder to narrow it down.</p>
    {/if}

    {#if error}
      <p class="msg error"><TriangleAlert size={13} strokeWidth={1.75} /> <span>{error}</span></p>
    {/if}
  </section>
</div>

{#if selected}
  <footer class="footer">
    <div class="footer-head">
      <div class="footer-title">
        <span class="name" title={selected.path}>{selected.name}</span>
        <span class="sub">
          {#if clipBusy}
            Putting it on the clip…
          {:else if onClip}
            On {onClip.clips === 1 ? "the clip" : `${onClip.clips} clips`}{onClip.checked ? ", showing in the Program monitor" : ""}
          {:else}
            {folderLabel(selected.folder)}
          {/if}
        </span>
      </div>
      {#if clipBusy}
        <LoaderCircle size={16} strokeWidth={1.75} class="spin muted" />
      {/if}
    </div>

    {#if onClip && !unsupported}
      <div class="actions">
        <button class="btn-primary flex-1" onclick={keep} disabled={clipBusy}><Check size={14} strokeWidth={2} /> Keep</button>
        <button class="btn-quiet flex-1 py-[0.45rem]" onclick={undo} disabled={clipBusy}><Undo2 size={14} strokeWidth={1.75} /> Undo</button>
      </div>
    {:else}
      <button class="btn-primary w-full" onclick={applyNow} disabled={clipBusy || !targetLabel}>
        {targetLabel ? "Put on clip" : "Select a clip first"}
      </button>
    {/if}

    <div class="links">
      <button class="link" onclick={() => (copyText(selected!.path) ? (status = "Path copied.") : (error = "Couldn't copy the path."))}><Copy size={12} strokeWidth={1.75} /> Copy path</button>
      <button class="link" onclick={() => hostApi.revealInFolder(selected!.path)}><FolderOpen size={12} strokeWidth={1.75} /> Show in folder</button>
      {#if unsupported}
        <button class="link" onclick={copyDiagnostics}>Copy Lumetri details</button>
        <button class="link" onclick={() => saveStrategy(null)}>Check again</button>
      {/if}
    </div>
    {#if status}
      <p class="msg" class:warn={unsupported}>{status}</p>
    {/if}
  </footer>
{/if}

<style>
  .lut {
    display: flex;
    flex-direction: column;
  }
  section {
    padding: 10px 12px;
  }
  .viewer-block {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .viewer {
    position: relative;
    border-radius: 4px;
    overflow: hidden;
    background: #000;
    user-select: none;
  }
  .viewer.splitting {
    cursor: ew-resize;
  }
  .viewer canvas {
    display: block;
    width: 100%;
    height: auto;
    aspect-ratio: 16 / 9;
    object-fit: contain;
  }
  .viewer-empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 24px;
    color: var(--color-panel-tertiary);
    text-align: center;
  }
  .viewer-empty p {
    margin: 0;
    color: var(--color-panel-secondary);
    font-size: 12px;
  }
  .split {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: rgba(255, 255, 255, 0.85);
    pointer-events: none;
  }
  .split span {
    position: absolute;
    top: 50%;
    left: 0;
    width: 12px;
    height: 28px;
    transform: translate(-50%, -50%);
    border-radius: 3px;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  }
  .tag {
    position: absolute;
    top: 8px;
    max-width: 55%;
    padding: 1px 6px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  .tag-right {
    right: 8px;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .frame-label {
    flex: 1;
    min-width: 0;
    padding: 0 4px;
    color: var(--color-panel-secondary);
    font-size: 11.5px;
    text-align: right;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 4px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--color-panel-secondary);
    cursor: pointer;
    flex-shrink: 0;
  }
  .icon-btn:hover:not(:disabled) {
    background: var(--color-surface-raised);
    color: var(--color-panel-text);
  }
  .icon-btn.active {
    background: var(--color-surface-raised);
    border-color: var(--color-panel-border);
    color: var(--color-panel-text);
  }
  .icon-btn:disabled {
    cursor: wait;
  }

  .slider {
    display: grid;
    grid-template-columns: 60px 1fr 40px;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--color-panel-secondary);
  }
  .slider .num {
    color: var(--color-panel-text);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .clip-row {
    display: flex;
    align-items: center;
    gap: 10px;
    border-top: 1px solid var(--color-panel-border);
    border-bottom: 1px solid var(--color-panel-border);
    background: var(--color-surface);
    color: var(--color-panel-secondary);
  }
  .clip-text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .clip-name {
    color: var(--color-panel-text);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .clip-row.none .clip-name {
    color: var(--color-panel-secondary);
    font-weight: 400;
  }
  .clip-sub {
    font-size: 11px;
    color: var(--color-panel-tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .switch {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .switch input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .track {
    position: relative;
    width: 26px;
    height: 14px;
    border-radius: 7px;
    background: var(--color-surface-overlay);
    transition: background 120ms;
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #cfcfcf;
    transition: transform 120ms;
  }
  .switch input:checked + .track {
    background: var(--color-accent);
  }
  .switch input:checked + .track .knob {
    transform: translateX(12px);
    background: #fff;
  }
  .switch input:focus-visible + .track {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .switch-label {
    font-size: 12px;
    color: var(--color-panel-text);
  }

  .library {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .lib-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .lib-head h2 {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
  }
  .lib-head span {
    color: var(--color-panel-tertiary);
    font-size: 11.5px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .count {
    color: var(--color-panel-tertiary);
  }
  .filters {
    display: flex;
    gap: 6px;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    padding: 0 6px 0 8px;
    border-radius: 4px;
    border: 1px solid var(--color-panel-border);
    background: var(--color-surface-raised);
    color: var(--color-panel-tertiary);
  }
  .search:focus-within {
    border-color: var(--color-accent);
  }
  .search input {
    flex: 1;
    min-width: 0;
    padding: 5px 0;
    border: none;
    outline: none;
    background: transparent;
    color: var(--color-panel-text);
    font-size: 12px;
  }
  .clear {
    display: flex;
    padding: 2px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--color-panel-secondary);
    cursor: pointer;
  }
  .clear:hover {
    color: var(--color-panel-text);
  }
  .filters select {
    width: 46%;
    padding: 5px 6px;
    border-radius: 4px;
    border: 1px solid var(--color-panel-border);
    background: var(--color-surface-raised);
    color: var(--color-panel-text);
    font-size: 12px;
    outline: none;
  }
  .link.quiet {
    align-self: flex-start;
    color: var(--color-panel-secondary);
    font-size: 11.5px;
  }
  .empty {
    margin: 0;
    padding: 4px 0;
    color: var(--color-panel-secondary);
    font-size: 12px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 6px;
  }
  .card {
    position: relative;
    padding: 3px;
    border-radius: 5px;
    border: 1px solid transparent;
  }
  .card:hover {
    background: var(--color-surface-raised);
  }
  .card.picked {
    border-color: var(--color-accent);
    background: var(--color-accent-soft);
  }
  .card-btn {
    display: block;
    width: 100%;
    padding: 0;
    border: none;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .card-btn:focus-visible {
    outline-offset: 2px;
  }
  .thumb {
    position: relative;
    aspect-ratio: 16 / 9;
    border-radius: 3px;
    overflow: hidden;
    background: var(--color-surface);
  }
  .thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .thumb-msg {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 8px;
    color: var(--color-panel-secondary);
    font-size: 11px;
    text-align: center;
  }
  .thumb-loading {
    position: absolute;
    inset: 0;
    background: var(--color-surface-raised);
    animation: pulse 1.2s ease-in-out infinite alternate;
  }
  @keyframes pulse {
    from { opacity: 0.4; }
    to { opacity: 1; }
  }
  .on-clip-badge {
    position: absolute;
    left: 4px;
    bottom: 4px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--color-accent);
    color: #fff;
    font-size: 10.5px;
    font-weight: 600;
  }
  .card-name {
    padding: 4px 2px 1px;
    font-size: 11.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card-folder {
    padding: 0 2px 1px;
    color: var(--color-panel-tertiary);
    font-size: 10.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .star {
    position: absolute;
    top: 7px;
    right: 7px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 3px;
    border: none;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    cursor: pointer;
    opacity: 0;
  }
  .card:hover .star,
  .star:focus-visible,
  .star.starred {
    opacity: 1;
  }
  .star.starred {
    color: #f5c242;
  }

  .msg {
    display: flex;
    gap: 6px;
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--color-panel-secondary);
    word-break: break-word;
  }
  .msg.error {
    color: var(--color-error);
  }
  .msg.warn {
    color: var(--color-warning);
  }
  .msg :global(svg) {
    flex-shrink: 0;
    margin-top: 2px;
  }

  .footer {
    position: sticky;
    bottom: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid var(--color-panel-border);
    background: var(--color-surface);
  }
  .footer-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .footer-title {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .footer-title .name {
    font-size: 12.5px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .footer-title .sub {
    color: var(--color-panel-secondary);
    font-size: 11.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
  }
  :global(.spin) {
    animation: spin 0.9s linear infinite;
  }
  :global(.muted) {
    color: var(--color-panel-secondary);
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .thumb-loading,
    :global(.spin) {
      animation: none;
    }
  }
</style>
