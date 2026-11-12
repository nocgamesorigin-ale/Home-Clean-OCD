// Plays the original sound clips (public/data/audio/<name>.mp3) with Web Audio.
const BASE = import.meta.env.BASE_URL + 'data/audio/';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();
let muted = false;

function ensureCtx(): void {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
  }
}

export function unlockAudio(): void {
  ensureCtx();
  if (ctx!.state === 'suspended') void ctx!.resume();
}

/** Fetch + decode a level's clips up front: a sound decoded on its first use comes late. */
export function preloadAudio(names: Iterable<string>): void {
  try {
    ensureCtx(); // a context made before any tap starts suspended, but it can decode
  } catch {
    return;
  }
  for (const n of names) void load(n);
}

/** Every looping sound still playing. */
const loops = new Set<Voice>();

/** Stop every loop (end of a step / level): no loop outlives the job that started it. */
export function stopLoops(fade = 0.2): void {
  for (const v of [...loops]) v.stop(fade);
}

export function setMuted(m: boolean): void {
  muted = m;
  if (master) master.gain.value = m ? 0 : 1;
}

function load(name: string): Promise<AudioBuffer | null> {
  let p = buffers.get(name);
  if (!p) {
    p = fetch(BASE + encodeURIComponent(name) + '.mp3')
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(name))))
      .then((b) => ctx!.decodeAudioData(b))
      .then((buf) => (trims.set(buf, edges(buf)), buf))
      .catch(() => null);
    buffers.set(name, p);
  }
  return p;
}

/** Where the sound really starts and ends in each clip: MP3s carry 30-330 ms of silence at the
 * head (the sound comes after the action) and tail (a gap at every loop point). */
const trims = new WeakMap<AudioBuffer, { start: number; end: number }>();

function edges(buf: AudioBuffer): { start: number; end: number } {
  const ch = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  const loud = (i: number) => ch.some((d) => Math.abs(d[i]) > 0.01);
  const n = buf.length;
  const maxHead = Math.min(n, Math.round(buf.sampleRate * 0.4));
  let a = 0;
  while (a < maxHead && !loud(a)) a++;
  if (a >= maxHead) a = 0; // a quiet clip: keep it whole
  let b = n - 1;
  const minTail = Math.max(a, n - Math.round(buf.sampleRate * 0.4));
  while (b > minTail && !loud(b)) b--;
  // keep a few ms before the attack so it is not cut
  const start = Math.max(0, a / buf.sampleRate - 0.004);
  const end = Math.min(buf.duration, (b + 1) / buf.sampleRate + 0.004);
  return end - start > 0.05 ? { start, end } : { start: 0, end: buf.duration };
}

export interface Voice {
  /** Stops the sound, fading out over `fade` seconds (no click). */
  stop(fade?: number): void;
}

export function play(name: string, opts: { loop?: boolean; volume?: number } = {}): Voice {
  let src: AudioBufferSourceNode | null = null;
  let gain: GainNode | null = null;
  let stopped = false;
  const asked = ctx ? ctx.currentTime : 0;
  // before the first tap the context is still asleep: one-shots asked then would all burst out
  // at once on the first tap
  if (ctx && master && (opts.loop || ctx.state === 'running')) {
    const c = ctx;
    const out = master;
    void load(name).then((buf) => {
      if (!buf || stopped) return;
      // a one-shot that could not start in time would sound after the action: skip it
      if (!opts.loop && c.currentTime - asked > 0.3) return;
      src = c.createBufferSource();
      src.buffer = buf;
      src.loop = !!opts.loop;
      const tr = trims.get(buf) ?? { start: 0, end: buf.duration };
      if (src.loop) {
        src.loopStart = tr.start;
        src.loopEnd = tr.end;
      }
      const g = (gain = c.createGain());
      const vol = opts.volume ?? 1;
      // a short fade-in: the trimmed head starts right on the sound, without a click
      g.gain.setValueAtTime(0, c.currentTime);
      g.gain.linearRampToValueAtTime(vol, c.currentTime + 0.004);
      src.connect(g).connect(out);
      src.start(0, tr.start);
    });
  }
  const voice: Voice = {
    stop(fade = 0) {
      if (stopped) return;
      stopped = true;
      loops.delete(voice);
      try {
        if (fade > 0 && ctx && gain && src) {
          const t = ctx.currentTime;
          gain.gain.cancelScheduledValues(t);
          gain.gain.setValueAtTime(gain.gain.value, t);
          gain.gain.linearRampToValueAtTime(0, t + fade);
          src.stop(t + fade + 0.02);
        } else src?.stop();
      } catch {
        /* already stopped */
      }
    },
  };
  if (opts.loop) loops.add(voice);
  return voice;
}
