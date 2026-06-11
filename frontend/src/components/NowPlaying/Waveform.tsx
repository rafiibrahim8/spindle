import { onCleanup, onMount } from 'solid-js';
import { usePlayerStore } from '../../store/playerStore';

const BAR_COUNT = 64;

export function Waveform() {
  const player = usePlayerStore();
  let canvas: HTMLCanvasElement | undefined;
  let raf = 0;

  onMount(() => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Allocate buffers once — the analyser size is fixed for the life of
    // the graph (fftSize: 256 → frequencyBinCount: 128). Re-allocating per
    // frame caused GC churn that contributed to audio stutter under load.
    let analyserBuffer: Uint8Array<ArrayBuffer> | null = null;
    const data = new Uint8Array(new ArrayBuffer(BAR_COUNT));

    // Cache the accent color and re-read it only when it changes (the user
    // changes theme rarely; reading getComputedStyle on every frame is slow).
    let accent = '#1ed760';
    let accentCheckAt = 0;

    // One shared full-height gradient, rebuilt only when the canvas height or
    // accent changes. Creating 64 per-bar gradients every frame (~11k
    // allocations/s) was GC churn of the same kind that caused audio stutter
    // before. Anchoring to the canvas instead of each bar means taller bars
    // reach further into the bright end — visually equivalent.
    let gradient: CanvasGradient | null = null;
    let gradientH = 0;
    let gradientAccent = '';
    const refreshAccent = (now: number) => {
      if (now - accentCheckAt < 1000) return;
      accentCheckAt = now;
      const next = getComputedStyle(document.documentElement)
        .getPropertyValue('--accent').trim();
      if (next) accent = next;
    };

    const draw = (now: number) => {
      // Bail when the tab is hidden — the rAF gets throttled to ~1 Hz anyway,
      // but explicitly returning avoids any canvas / read work on the audio
      // thread's slot.
      if (document.hidden) {
        raf = requestAnimationFrame(draw);
        return;
      }

      const analyser = player.getAnalyser();
      const c = canvas!;
      const w = c.clientWidth * devicePixelRatio;
      const h = c.clientHeight * devicePixelRatio;
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      ctx.clearRect(0, 0, w, h);

      if (analyser) {
        if (!analyserBuffer || analyserBuffer.length !== analyser.frequencyBinCount) {
          analyserBuffer = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
        }
        analyser.getByteFrequencyData(analyserBuffer);
        const step = Math.max(1, Math.floor(analyserBuffer.length / BAR_COUNT));
        for (let i = 0; i < BAR_COUNT; i++) data[i] = analyserBuffer[i * step] || 0;
      } else {
        for (let i = 0; i < BAR_COUNT; i++) data[i] = 0;
      }

      refreshAccent(now);
      if (!gradient || gradientH !== h || gradientAccent !== accent) {
        gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, accent);
        gradient.addColorStop(1, accent + '55');
        gradientH = h;
        gradientAccent = accent;
      }
      ctx.fillStyle = gradient;

      const gap = (w / BAR_COUNT) * 0.2;
      const barW = w / BAR_COUNT - gap;

      for (let i = 0; i < BAR_COUNT; i++) {
        const v = data[i] / 255;
        const barH = Math.max(2 * devicePixelRatio, v * h);
        const x = i * (barW + gap);
        ctx.fillRect(x, h - barH, barW, barH);
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  return <canvas ref={canvas} class="waveform" />;
}
