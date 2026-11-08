<script lang="ts">
  import * as webviewAPI from "./webview-api";
  import { setSequenceCallbacks } from "./webview-api";
  import { initWebview } from "./webview-setup";
  import { isCEP } from "./cep/api";
  import { sessionManager } from "./lib/session/manager.svelte";
  import type { TranscriptJSON, SequenceInfo } from "./lib/types";

  import AppBar from "./components/AppBar.svelte";
  import Home, { type Tool } from "./components/Home.svelte";
  import LutPanel from "./components/LutPanel.svelte";
  import { toolStatus } from "./lib/toolStatus.svelte";
  import TranscriptPreview from "./components/TranscriptPreview.svelte";
  import CanvasPreview from "./components/CanvasPreview.svelte";
  import StylePanel from "./components/StylePanel.svelte";
  import PresetsPanel from "./components/PresetsPanel.svelte";
  import AnimationPanel from "./components/AnimationPanel.svelte";
  import ExportButton from "./components/ExportButton.svelte";
  import CaptionExport from "./components/CaptionExport.svelte";
  import OfflineCaptions from "./components/OfflineCaptions.svelte";
  import BeatsPanel from "./components/BeatsPanel.svelte";

  const { api, page } = initWebview(webviewAPI);

  setSequenceCallbacks(
    () => refreshSequence(),
    () => sessionManager.deactivateSequence(),
  );

  // The home menu comes first; each tool opens on its own screen.
  let view = $state<"home" | Tool>("home");
  const titles = { home: "Better Captions", captions: "Captions", beats: "Beat Markers", luts: "LUT Preview" };
  let captionsStatus = $derived.by(() => {
    const s = sessionManager.current;
    if (!s) return "Open a sequence to start";
    return s.captions.length ? `${s.captions.length} captions ready for ${s.sequenceName}` : "No captions yet for this sequence";
  });
  let beatsStatus = $derived(toolStatus.bpm ? `Last found ${toolStatus.bpm} BPM in ${toolStatus.beatsSource}` : "Not analysed yet");
  let lutsStatus = $derived(toolStatus.lut ? `Picked ${toolStatus.lut}` : "Uses Premiere's LUTs and your own folders");

  // Why the panel couldn't read the sequence (CEP only), shown on the empty screen.
  let connectionError = $state<string | null>(null);

  refreshSequence();

  async function refreshSequence() {
    try {
      const info = await api.getActiveSequenceInfo();
      if (info) {
        connectionError = null;
        sessionManager.activateSequence(info as SequenceInfo);
        await fetchTranscript();
      } else {
        sessionManager.deactivateSequence();
        connectionError = isCEP() ? await (api as any).getConnectionError() : null;
      }
    } catch (e: any) {
      console.error("refreshSequence failed:", e);
      sessionManager.deactivateSequence();
      connectionError = e?.message || String(e);
    }
  }

  async function fetchTranscript() {
    const session = sessionManager.current;
    if (!session) return;

    sessionManager.setLoading(true);
    try {
      const offline = await api.loadOfflineTranscript(session.sequenceId);
      if (offline) {
        sessionManager.setTranscript(JSON.parse(offline as string), "offline");
        sessionManager.setLoading(false);
        return;
      }
    } catch (e) {
      console.error("loading offline transcript failed:", e);
    }
    try {
      const json = await api.fetchTranscriptJSON();
      if (json) {
        const parsed: TranscriptJSON = JSON.parse(json as string);
        sessionManager.setTranscript(parsed);
      } else {
        sessionManager.clearTranscript();
      }
    } catch (e) {
      console.error("fetchTranscript failed:", e);
      sessionManager.clearTranscript();
    }
    sessionManager.setLoading(false);
  }

  function handleOfflineGenerated(sequenceId: string, transcript: TranscriptJSON) {
    if (sessionManager.current?.sequenceId === sequenceId) {
      sessionManager.setTranscript(transcript, "offline");
    }
  }

  function handleTimeChange(time: number) {
    sessionManager.setCurrentTime(time);
  }
</script>

<div class="flex flex-col h-screen overflow-hidden tool-{view}">
  <AppBar
    title={titles[view]}
    onBack={view === "home" ? undefined : () => (view = "home")}
    sequenceName={sessionManager.current?.sequenceName ?? null}
    duration={sessionManager.current?.duration}
    onRefresh={refreshSequence}
  />

  {#if view === "home"}
    <div class="flex-1 overflow-y-auto">
      <Home onOpen={(tool) => (view = tool)} {captionsStatus} {beatsStatus} {lutsStatus} fullTools={isCEP()} />
      {#if connectionError}
        <p class="text-[12px] text-red-400 px-4 pb-4 break-words">{connectionError}</p>
      {/if}
    </div>
  {:else if view === "beats"}
    <div class="flex-1 overflow-y-auto">
      <BeatsPanel hostApi={api} standalone />
    </div>
  {:else if view === "luts"}
    <div class="flex-1 overflow-y-auto">
      <LutPanel hostApi={api} />
    </div>
  {:else if sessionManager.current}
    {@const session = sessionManager.current}
    <div class="sticky top-0 z-10">
      <CanvasPreview
        captions={session.captions}
        currentTime={session.currentTime}
        duration={session.duration}
        style={session.style}
        animation={session.animation}
        frameWidth={session.frameWidth}
        frameHeight={session.frameHeight}
        onTimeChange={handleTimeChange}
      />
    </div>

    <div class="flex-1 overflow-y-auto">
      <OfflineCaptions
        hostApi={api}
        sequenceId={session.sequenceId}
        transcriptSource={session.transcriptSource}
        onGenerated={handleOfflineGenerated}
        onUsePremiere={fetchTranscript}
        canUsePremiereTranscript={!isCEP()}
        canUseFiles={isCEP()}
      />

      <TranscriptPreview
        captions={session.captions}
        currentTime={session.currentTime}
        maxWords={session.style.maxWords}
        onSeek={handleTimeChange}
        onMaxWordsChange={(val) => sessionManager.updateStyle({ maxWords: val })}
      />

      <PresetsPanel
        style={session.style}
        animation={session.animation}
        hostApi={api}
        onApply={(look) => {
          sessionManager.updateStyle(look.style);
          sessionManager.updateAnimation(look.animation);
        }}
      />

      <StylePanel
        style={session.style}
        onUpdate={(updates) => sessionManager.updateStyle(updates)}
      />

      <AnimationPanel
        animation={session.animation}
        onUpdate={(updates) => sessionManager.updateAnimation(updates)}
      />

      <CaptionExport
        captions={session.captions}
        transcript={session.transcriptJson}
        style={session.style}
        animation={session.animation}
        frameWidth={session.frameWidth}
        frameRate={session.frameRate}
        sequenceName={session.sequenceName}
        hostApi={api}
        canAddToTimeline={isCEP()}
      />

      {#if !isCEP()}
        <ExportButton
          captions={session.captions}
          style={session.style}
          animation={session.animation}
          frameWidth={session.frameWidth}
          frameHeight={session.frameHeight}
          frameRate={session.frameRate}
          duration={session.duration}
          sequenceName={session.sequenceName}
          hostApi={api}
        />
      {/if}
    </div>
  {:else}
    <div class="flex-1 flex flex-col items-center justify-center p-6 text-center">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" class="text-panel-secondary mb-3 opacity-40">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
      <p class="font-display text-[15px] text-panel-text mb-1">No sequence open</p>
      <p class="text-[12px] text-panel-secondary">
        Open or click into a sequence in Premiere Pro to caption it.
      </p>
      {#if connectionError}
        <p class="text-[11px] text-red-400 mt-3 max-w-[320px] break-words">{connectionError}</p>
      {/if}
      <button
        onclick={refreshSequence}
        class="mt-3 py-1.5 px-3 rounded text-[12px] border border-panel-border bg-surface-raised text-panel-text cursor-pointer hover:bg-panel-hover-bg"
      >
        Try again
      </button>
    </div>
  {/if}
</div>
