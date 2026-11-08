<script lang="ts">
  import { onMount } from "svelte";
  import { CaptionRenderer } from "../lib/canvas/engine";
  import { DEFAULT_ANIMATION, DEFAULT_STYLE, type AnimationConfig, type CaptionItem, type StyleConfig } from "../lib/types";
  import type { CaptionPreset } from "../lib/presets";

  interface Props {
    preset: CaptionPreset;
  }

  let { preset }: Props = $props();

  const WIDTH = 220;
  const HEIGHT = 64;
  // Sample line, drawn just after the second word starts so animations show.
  const SAMPLE: CaptionItem = {
    id: "sample",
    text: "Your captions here",
    startTime: 0,
    endTime: 3,
    words: [
      { text: "Your", startTime: 0, endTime: 0.5, isActive: false },
      { text: "captions", startTime: 0.5, endTime: 1.2, isActive: false },
      { text: "here", startTime: 1.2, endTime: 3, isActive: false },
    ],
  };
  const SAMPLE_TIME = 1.0;

  let canvas: HTMLCanvasElement | undefined = $state();

  function draw() {
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    const style: StyleConfig = { ...DEFAULT_STYLE, ...preset.style };
    const animation: AnimationConfig = { ...DEFAULT_ANIMATION, ...preset.animation };
    // Shrink everything to thumbnail size, keeping the proportions of the look,
    // and small enough that the whole sample line fits the card.
    let size = 24;
    ctx.font = `${style.fontWeight} ${size}px "${style.fontFamily}"`;
    const sample = style.textTransform === "uppercase" ? SAMPLE.text.toUpperCase() : SAMPLE.text;
    const textWidth = ctx.measureText(sample).width + style.backgroundPadding * (size / Math.max(style.fontSize, 1)) * 2;
    if (textWidth > WIDTH * 0.88) size *= (WIDTH * 0.88) / textWidth;
    const k = size / Math.max(style.fontSize, 1);
    const small: StyleConfig = {
      ...style,
      fontSize: size,
      strokeWidth: style.strokeWidth * k,
      backgroundPadding: style.backgroundPadding * k,
      backgroundRadius: style.backgroundRadius * k,
      shadowBlur: style.shadowBlur * k,
      shadowOffsetX: style.shadowOffsetX * k,
      shadowOffsetY: style.shadowOffsetY * k,
      glowBlur: style.glowBlur * k,
      positionX: 0.5,
      positionY: 0.5,
      maxWidth: 0.95,
    };
    new CaptionRenderer(ctx, WIDTH, HEIGHT).renderFrame(SAMPLE, SAMPLE_TIME, small, animation);
  }

  onMount(() => {
    if (!canvas) return;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    draw();
    document.fonts.load(`${preset.style.fontWeight ?? 700} 24px "${preset.style.fontFamily ?? "Arial"}"`).then(draw, () => {});
    window.addEventListener("bc-fonts-ready", draw);
    return () => window.removeEventListener("bc-fonts-ready", draw);
  });

  $effect(() => {
    JSON.stringify(preset);
    draw();
  });
</script>

<canvas bind:this={canvas} class="w-full h-auto block rounded" style="background:#3a3a3a"></canvas>
