import { gsap } from "gsap";
import type {
  CaptionItem,
  CaptionWord,
  StyleConfig,
  AnimationConfig,
  AnimationPreset,
} from "../types";

function applyTextTransform(text: string, transform: string): string {
  if (transform === "uppercase") return text.toUpperCase();
  if (transform === "lowercase") return text.toLowerCase();
  return text;
}

function hexToRgba(hex: string, opacity: number): string {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${opacity})`;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Distance between stacked captions when speakers overlap.
export function stackStep(style: StyleConfig) {
  return style.fontSize * style.lineHeight + style.backgroundPadding * 2 + style.fontSize * 0.15;
}

// Easing curves from GSAP; the renderer draws any moment on demand (needed for
// export), so it uses GSAP's eases rather than its playback timeline.
const EASE = {
  power2: gsap.parseEase("power2.out"),
  back: gsap.parseEase("back.out(2)"),
  expo: gsap.parseEase("expo.out"),
  bounce: gsap.parseEase("bounce.out"),
  elastic: gsap.parseEase("elastic.out(1, 0.45)"),
};

// Fade motion amounts, relative to the font size where it matters.
export const SLIDE_DISTANCE = 0.35;
const ZOOM_FROM = 0.85;
const BLUR_AMOUNT = 0.12;

// Glow is drawn as a shadow cast by text placed far off-canvas, so only the
// glow lands on the frame and the letters themselves aren't tinted.
const GLOW_OFFSET = 10000;

interface WordMetrics {
  word: CaptionWord;
  text: string;
  x: number;
  width: number;
}

export class CaptionRenderer {
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;

  constructor(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
  ) {
    this.ctx = ctx;
    this.width = width;
    this.height = height;
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  // Draws one caption, or several stacked around the caption position when
  // speakers overlap (each on its own line, in time order).
  renderFrame(
    captions: CaptionItem | CaptionItem[] | null,
    currentTime: number,
    style: StyleConfig,
    animation: AnimationConfig,
  ) {
    this.clear();
    const list = captions ? (Array.isArray(captions) ? captions : [captions]) : [];
    const step = stackStep(style);
    list.forEach((caption, k) => {
      this.drawCaption(caption, currentTime, style, animation, (k - (list.length - 1) / 2) * step);
    });
  }

  private drawCaption(
    caption: CaptionItem,
    currentTime: number,
    style: StyleConfig,
    animation: AnimationConfig,
    offsetY: number,
  ) {
    const progress = this.getCaptionProgress(caption, currentTime, animation, style);
    if (progress.opacity <= 0) return;

    this.ctx.save();
    this.ctx.globalAlpha = progress.opacity;

    const pivotX = this.width * style.positionX;
    const pivotY = this.height * style.positionY + offsetY;
    if (progress.offsetY || progress.scale !== 1) {
      this.ctx.translate(pivotX, pivotY + progress.offsetY);
      this.ctx.scale(progress.scale, progress.scale);
      this.ctx.translate(-pivotX, -pivotY);
    }
    if (progress.blur > 0.1) {
      this.ctx.filter = `blur(${progress.blur.toFixed(1)}px)`;
    }

    const font = `${style.fontWeight} ${style.fontSize}px "${style.fontFamily}"`;
    this.ctx.font = font;
    this.ctx.textBaseline = "middle";

    const fullText = applyTextTransform(caption.text, style.textTransform);
    const maxWidthPx = this.width * style.maxWidth;
    const centerX = this.width * style.positionX;
    const centerY = this.height * style.positionY + offsetY;

    const wordMetrics = this.measureWords(caption.words, style, maxWidthPx, centerX, animation);

    this.drawBackground(wordMetrics, style, centerY, progress);
    this.drawWords(wordMetrics, caption, currentTime, style, animation, centerY, progress);

    this.ctx.restore();
  }

  private measureWords(
    words: CaptionWord[],
    style: StyleConfig,
    maxWidthPx: number,
    centerX: number,
    animation?: AnimationConfig,
  ): WordMetrics[] {
    const metrics: WordMetrics[] = [];
    // Animations that enlarge or box the spoken word need wider gaps so it doesn't cover its neighbours.
    const extraGap = { spotlight: 0.32, box: 0.22, pop: 0.12, elastic: 0.15 }[animation?.preset as string] ?? 0;
    const spaceWidth = this.ctx.measureText(" ").width + style.fontSize * extraGap;

    let totalWidth = 0;
    const wordWidths: number[] = [];

    for (const word of words) {
      const text = applyTextTransform(word.text, style.textTransform);
      const w = this.ctx.measureText(text).width;
      wordWidths.push(w);
      totalWidth += w;
    }
    totalWidth += spaceWidth * Math.max(0, words.length - 1);

    let startX: number;
    if (style.textAlign === "center") {
      startX = centerX - totalWidth / 2;
    } else if (style.textAlign === "right") {
      startX = centerX + maxWidthPx / 2 - totalWidth;
    } else {
      startX = centerX - maxWidthPx / 2;
    }

    let x = startX;
    for (let i = 0; i < words.length; i++) {
      const text = applyTextTransform(words[i].text, style.textTransform);
      metrics.push({ word: words[i], text, x, width: wordWidths[i] });
      x += wordWidths[i] + spaceWidth;
    }

    return metrics;
  }

  private drawBackground(
    wordMetrics: WordMetrics[],
    style: StyleConfig,
    centerY: number,
    progress: AnimationProgress,
  ) {
    if (!style.backgroundEnabled) return;
    if (!style.backgroundColor || style.backgroundColor === "transparent") return;
    if (wordMetrics.length === 0) return;

    const first = wordMetrics[0];
    const last = wordMetrics[wordMetrics.length - 1];
    const totalWidth = last.x + last.width - first.x;
    const pad = style.backgroundPadding;
    const h = style.fontSize * style.lineHeight;

    const bgX = first.x - pad;
    const bgY = centerY - h / 2 - pad;
    const bgW = totalWidth + pad * 2;
    const bgH = h + pad * 2;

    this.ctx.fillStyle = hexToRgba(style.backgroundColor, style.backgroundOpacity ?? 0.6);

    if (style.backgroundRadius > 0) {
      this.roundRect(bgX, bgY, bgW, bgH, style.backgroundRadius);
      this.ctx.fill();
    } else {
      this.ctx.fillRect(bgX, bgY, bgW, bgH);
    }
  }

  private drawWords(
    wordMetrics: WordMetrics[],
    caption: CaptionItem,
    currentTime: number,
    style: StyleConfig,
    animation: AnimationConfig,
    centerY: number,
    progress: AnimationProgress,
  ) {
    // The word being spoken right now: the last one that has started.
    let currentIndex = -1;
    wordMetrics.forEach((wm, i) => {
      if (currentTime >= wm.word.startTime) currentIndex = i;
    });

    for (let i = 0; i < wordMetrics.length; i++) {
      const wm = wordMetrics[i];
      const word = wm.word;
      const isWordActive = currentTime >= word.startTime;
      const isCurrent = i === currentIndex;
      // Seconds since this word started, and progress through an entrance of `seconds`.
      const elapsed = currentTime - word.startTime;
      const enter = (seconds: number) => clamp(elapsed / seconds, 0, 1);
      const size = style.fontSize;

      this.ctx.save();

      let drawX = wm.x;
      let drawY = centerY;
      let wordAlpha = 1;
      let scale = 1;
      let blur = 0;
      let highlight = false;
      let box = 0;

      switch (animation.preset) {
        case "none":
          break;

        case "fade":
          wordAlpha = isWordActive ? EASE.power2(enter(0.35)) : 0;
          break;

        case "typewriter":
          wordAlpha = isWordActive ? 1 : 0;
          break;

        case "pop": {
          const t = enter(0.25);
          wordAlpha = isWordActive ? Math.min(1, t * 3) : 0;
          scale = isWordActive ? EASE.back(t) : 1;
          break;
        }

        case "karaoke":
          highlight = isWordActive;
          break;

        case "bounce": {
          const t = enter(0.3);
          wordAlpha = isWordActive ? Math.min(1, t * 3) : 0;
          drawY -= (1 - EASE.back(t)) * size * 0.2;
          break;
        }

        case "slide": {
          const t = enter(0.3);
          wordAlpha = isWordActive ? Math.min(1, t * 2) : 0;
          drawY += (1 - EASE.expo(t)) * size * 0.45;
          break;
        }

        case "drop": {
          const t = enter(0.55);
          wordAlpha = isWordActive ? Math.min(1, t * 4) : 0;
          drawY -= (1 - EASE.bounce(t)) * size * 0.6;
          break;
        }

        case "elastic": {
          const t = enter(0.7);
          wordAlpha = isWordActive ? Math.min(1, t * 4) : 0;
          scale = isWordActive ? Math.max(0.01, EASE.elastic(t)) : 1;
          break;
        }

        case "blur": {
          const t = enter(0.35);
          wordAlpha = isWordActive ? EASE.power2(t) : 0;
          blur = (1 - EASE.expo(t)) * size * 0.15;
          break;
        }

        case "wave":
          drawY += Math.sin(currentTime * Math.PI * 2.4 - i * 0.7) * size * 0.06;
          break;

        case "box":
          if (isCurrent && isWordActive) box = EASE.back(enter(0.18));
          break;

        case "spotlight":
          if (isCurrent && isWordActive) {
            highlight = true;
            scale = 1 + 0.1 * EASE.back(enter(0.2));
          } else {
            wordAlpha = 0.45;
          }
          break;
      }

      this.ctx.globalAlpha = progress.opacity * wordAlpha;
      if (blur > 0.3) this.ctx.filter = `blur(${blur.toFixed(1)}px)`;

      if (scale !== 1) {
        this.ctx.translate(drawX + wm.width / 2, drawY);
        this.ctx.scale(scale, scale);
        this.ctx.translate(-(drawX + wm.width / 2), -drawY);
      }

      if (box > 0) {
        // Highlight box behind the spoken word, popping in from its centre.
        const pad = size * 0.14;
        const w = (wm.width + pad * 2) * box;
        const h = size * 1.2 * box;
        this.ctx.fillStyle = animation.highlightColor;
        this.roundRect(drawX + wm.width / 2 - w / 2, drawY - h / 2, w, h, size * 0.18 * box);
        this.ctx.fill();
      }

      if (style.glowEnabled && (!style.glowActiveOnly || i === currentIndex)) {
        this.drawGlow(wm.text, drawX, drawY, style);
      }

      if ((style.shadowEnabled ?? true) && style.shadowBlur > 0) {
        this.ctx.shadowColor = hexToRgba(style.shadowColor, style.shadowOpacity ?? 0.5);
        this.ctx.shadowBlur = style.shadowBlur;
        this.ctx.shadowOffsetX = style.shadowOffsetX;
        this.ctx.shadowOffsetY = style.shadowOffsetY;
      }

      if (style.strokeEnabled && style.strokeWidth > 0) {
        this.ctx.strokeStyle = hexToRgba(style.strokeColor, style.strokeOpacity ?? 1);
        this.ctx.lineWidth = style.strokeWidth * 2;
        this.ctx.lineJoin = "round";
        this.ctx.strokeText(wm.text, drawX, drawY);
        this.ctx.shadowBlur = 0;
      }

      this.ctx.fillStyle = highlight ? animation.highlightColor : (caption.color ?? style.textColor);
      this.ctx.fillText(wm.text, drawX, drawY);

      this.ctx.restore();
    }
  }

  private drawGlow(text: string, x: number, y: number, style: StyleConfig) {
    if (style.glowBlur <= 0 || style.glowOpacity <= 0) return;
    this.ctx.save();
    // Shadow offsets ignore the transform, so convert the off-canvas distance
    // into the current (possibly scaled) drawing units.
    const scaleX = this.ctx.getTransform().a || 1;
    this.ctx.shadowColor = hexToRgba(style.glowColor, style.glowOpacity);
    this.ctx.shadowBlur = style.glowBlur;
    this.ctx.shadowOffsetX = GLOW_OFFSET;
    this.ctx.shadowOffsetY = 0;
    this.ctx.fillStyle = "#000";
    const passes = clamp(Math.round(style.glowStrength), 1, 4);
    for (let p = 0; p < passes; p++) {
      this.ctx.fillText(text, x - GLOW_OFFSET / scaleX, y);
    }
    this.ctx.restore();
  }

  private getCaptionProgress(
    caption: CaptionItem,
    currentTime: number,
    animation: AnimationConfig,
    style: StyleConfig,
  ): AnimationProgress {
    const none: AnimationProgress = { opacity: 1, scale: 1, offsetY: 0, blur: 0 };
    if (animation.fadeEnabled === false) return none;

    let fadeIn = Math.max(0, animation.fadeInDuration);
    let fadeOut = Math.max(0, animation.fadeOutDuration);
    const captionDuration = Math.max(caption.endTime - caption.startTime, 0.01);

    // Short captions: shrink both fades so they never overlap.
    if (fadeIn + fadeOut > captionDuration) {
      const k = captionDuration / (fadeIn + fadeOut);
      fadeIn *= k;
      fadeOut *= k;
    }

    const elapsed = currentTime - caption.startTime;
    const remaining = caption.endTime - currentTime;
    const inAmount = fadeIn > 0 ? easeOutCubic(clamp(elapsed / fadeIn, 0, 1)) : 1;
    const outAmount = fadeOut > 0 ? easeOutCubic(clamp(remaining / fadeOut, 0, 1)) : 1;
    const amount = Math.min(inAmount, outAmount);
    const fadingIn = inAmount <= outAmount;
    const hidden = 1 - amount;

    const progress: AnimationProgress = { ...none, opacity: clamp(amount, 0, 1) };
    switch (animation.fadeMotion) {
      case "slide":
        // Rises into place, then keeps rising as it fades out.
        progress.offsetY = hidden * style.fontSize * SLIDE_DISTANCE * (fadingIn ? 1 : -1);
        break;
      case "zoom":
        progress.scale = ZOOM_FROM + (1 - ZOOM_FROM) * amount;
        break;
      case "blur":
        progress.blur = hidden * style.fontSize * BLUR_AMOUNT;
        break;
    }
    return progress;
  }

  private roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ) {
    this.ctx.beginPath();
    this.ctx.moveTo(x + r, y);
    this.ctx.lineTo(x + w - r, y);
    this.ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    this.ctx.lineTo(x + w, y + h - r);
    this.ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    this.ctx.lineTo(x + r, y + h);
    this.ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    this.ctx.lineTo(x, y + r);
    this.ctx.quadraticCurveTo(x, y, x + r, y);
    this.ctx.closePath();
  }
}

interface AnimationProgress {
  opacity: number;
  scale: number;
  offsetY: number;
  blur: number;
}
