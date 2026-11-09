<script lang="ts">
  import SectionHeader from "./SectionHeader.svelte";
  import WandSparkles from "@lucide/svelte/icons/wand-sparkles";
  import type { AnimationConfig, AnimationPreset, FadeMotion } from "../lib/types";

  interface Props {
    animation: AnimationConfig;
    onUpdate: (updates: Partial<AnimationConfig>) => void;
  }

  let { animation, onUpdate }: Props = $props();

  let localAnim = $state<AnimationConfig>({ ...animation });

  $effect(() => {
    localAnim = { ...animation };
  });

  function handleUpdate(updates: Partial<AnimationConfig>) {
    localAnim = { ...localAnim, ...updates };
    onUpdate(updates);
  }

  let isOpen = $state(true);

  const presets: { value: AnimationPreset; label: string; description: string }[] = [
    { value: "none", label: "None", description: "No word animation: the whole caption shows at once" },
    { value: "fade", label: "Fade", description: "Each word fades in as it's spoken" },
    { value: "typewriter", label: "Type", description: "Words appear one by one as they're spoken" },
    { value: "pop", label: "Pop", description: "Words pop in with a little overshoot" },
    { value: "karaoke", label: "Karaoke", description: "Spoken words switch to the highlight colour" },
    { value: "bounce", label: "Bounce", description: "Words bounce down into place" },
    { value: "slide", label: "Slide up", description: "Words rise smoothly into place" },
    { value: "drop", label: "Drop", description: "Words drop in from above and bounce" },
    { value: "elastic", label: "Elastic", description: "Words spring in with an elastic wobble" },
    { value: "blur", label: "Blur in", description: "Words sharpen from a blur as they're spoken" },
    { value: "wave", label: "Wave", description: "The whole line gently waves" },
    { value: "box", label: "Box", description: "A coloured box highlights the word being spoken" },
    { value: "spotlight", label: "Spotlight", description: "The spoken word grows and lights up; the rest dim" },
  ];

  const fadeMotions: { value: FadeMotion; label: string; description: string }[] = [
    { value: "none", label: "Plain", description: "Plain fade in and out, no movement" },
    { value: "slide", label: "Slide", description: "Fade while rising into place and out" },
    { value: "zoom", label: "Zoom", description: "Fade while growing in and shrinking out" },
    { value: "blur", label: "Blur", description: "Fade from a soft blur into focus" },
  ];
</script>

<div class="border-b border-panel-border">
  <SectionHeader title="Animation" icon={WandSparkles} open={isOpen} onToggle={() => (isOpen = !isOpen)} />

  {#if isOpen}
    <div class="px-3 py-2.5 space-y-2.5">
      <div class="grid grid-cols-4 gap-1.5">
        {#each presets as preset}
          <button
            onclick={() => handleUpdate({ preset: preset.value })}
            class="flex flex-col items-center gap-0.5 py-2 px-1 rounded border cursor-pointer transition-colors"
            style="border-color:{localAnim.preset === preset.value ? 'var(--color-accent)' : 'var(--color-panel-border)'};background:{localAnim.preset === preset.value ? 'var(--color-accent-soft)' : 'var(--color-surface-raised)'}"
            title={preset.description}
          >
            <span
              class="text-[12px] font-medium"
              style="color:{localAnim.preset === preset.value ? 'var(--color-accent)' : 'var(--color-panel-text)'}"
            >
              {preset.label}
            </span>
          </button>
        {/each}
      </div>

      <div class="text-[12px] text-panel-secondary px-0.5">
        {presets.find((p) => p.value === localAnim.preset)?.description}
      </div>

      <div class="border border-panel-border rounded overflow-hidden">
        <div class="flex items-center justify-between px-2.5 py-1.5 bg-surface">
          <span class="text-[12.5px] font-semibold text-panel-text">Fade In / Out</span>
          <button
            onclick={() => handleUpdate({ fadeEnabled: !(localAnim.fadeEnabled ?? true) })}
            aria-label="Toggle fade in and out"
            class="relative w-7 h-4 rounded-full cursor-pointer border-none"
            style="background:{localAnim.fadeEnabled ?? true ? 'var(--color-accent)' : 'var(--color-panel-border)'};transition:background 150ms"
          >
            <span
              class="absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full"
              style="transform:translateX({localAnim.fadeEnabled ?? true ? '0.75rem' : '0'});transition:transform 150ms"
            ></span>
          </button>
        </div>
        {#if localAnim.fadeEnabled ?? true}
          <div class="px-2.5 py-2 space-y-2">
            <div class="grid grid-cols-4 gap-1.5">
              {#each fadeMotions as motion}
                <button
                  onclick={() => handleUpdate({ fadeMotion: motion.value })}
                  title={motion.description}
                  class="py-1.5 rounded border cursor-pointer text-[12px] font-medium transition-colors"
                  style="border-color:{(localAnim.fadeMotion ?? 'none') === motion.value ? 'var(--color-accent)' : 'var(--color-panel-border)'};background:{(localAnim.fadeMotion ?? 'none') === motion.value ? 'var(--color-accent-soft)' : 'var(--color-surface-raised)'};color:{(localAnim.fadeMotion ?? 'none') === motion.value ? 'var(--color-accent)' : 'var(--color-panel-text)'}"
                >
                  {motion.label}
                </button>
              {/each}
            </div>
            <div class="text-[11px] text-panel-secondary px-0.5">
              {fadeMotions.find((m) => m.value === (localAnim.fadeMotion ?? "none"))?.description}
            </div>
      <div class="grid grid-cols-2 gap-2">
        <label class="flex flex-col gap-1">
          <span class="text-[12px] text-panel-secondary">Fade In (s)</span>
          <input
            type="number"
            value={localAnim.fadeInDuration}
            min={0}
            max={2}
            step={0.05}
            onchange={(e) =>
              handleUpdate({ fadeInDuration: Number((e.target as HTMLInputElement).value) })}
            class="bg-surface-raised text-panel-text text-[13px] px-2 py-1.5 rounded border border-panel-border focus:border-accent outline-none w-full"
          />
        </label>

        <label class="flex flex-col gap-1">
          <span class="text-[12px] text-panel-secondary">Fade Out (s)</span>
          <input
            type="number"
            value={localAnim.fadeOutDuration}
            min={0}
            max={2}
            step={0.05}
            onchange={(e) =>
              handleUpdate({ fadeOutDuration: Number((e.target as HTMLInputElement).value) })}
            class="bg-surface-raised text-panel-text text-[13px] px-2 py-1.5 rounded border border-panel-border focus:border-accent outline-none w-full"
          />
        </label>
      </div>
          </div>
        {/if}
      </div>

      {#if ["karaoke", "box", "spotlight"].includes(localAnim.preset)}
        <label class="flex flex-col gap-1">
          <span class="text-[12px] text-panel-secondary">Highlight Color</span>
          <div class="flex items-center gap-2">
            <input
              type="color"
              value={localAnim.highlightColor}
              oninput={(e) =>
                handleUpdate({ highlightColor: (e.target as HTMLInputElement).value })}
              class="w-7 h-7 rounded border border-panel-border cursor-pointer p-0"
            />
            <span class="text-[12px] text-panel-secondary">{localAnim.highlightColor}</span>
          </div>
        </label>
      {/if}
    </div>
  {/if}
</div>
