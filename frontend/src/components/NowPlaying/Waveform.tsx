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

    const data = new Uint8Array(BAR_COUNT * 2);

    const draw = () => {
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
        const buffer = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(buffer);
        // Take every Nth bucket so we end up with BAR_COUNT bars.
        const step = Math.max(1, Math.floor(buffer.length / BAR_COUNT));
        for (let i = 0; i < BAR_COUNT; i++) data[i] = buffer[i * step] || 0;
      } else {
        for (let i = 0; i < BAR_COUNT; i++) data[i] = 0;
      }

      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1ed760';
      const gap = w / BAR_COUNT * 0.2;
      const barW = w / BAR_COUNT - gap;

      for (let i = 0; i < BAR_COUNT; i++) {
        const v = data[i] / 255;
        const barH = Math.max(2 * devicePixelRatio, v * h);
        const x = i * (barW + gap);
        const y = h - barH;
        const grad = ctx.createLinearGradient(0, y, 0, h);
        grad.addColorStop(0, accent);
        grad.addColorStop(1, accent + '55');
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, barW, barH);
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  return <canvas ref={canvas} class="waveform" />;
}
