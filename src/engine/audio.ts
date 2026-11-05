// Plays the original sound clips (public/data/audio/<name>.mp3) with Web Audio.
const BASE = import.meta.env.BASE_URL + 'data/audio/';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();
let muted = false;

export function unlockAudio(): void {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
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
      .catch(() => null);
    buffers.set(name, p);
  }
  return p;
}

export interface Voice {
  /** Stops the sound, fading out over `fade` seconds (no click). */
  stop(fade?: number): void;
}

export function play(name: string, opts: { loop?: boolean; volume?: number } = {}): Voice {
  let src: AudioBufferSourceNode | null = null;
  let gain: GainNode | null = null;
  let stopped = false;
  if (ctx && master) {
    const c = ctx;
    const out = master;
    void load(name).then((buf) => {
      if (!buf || stopped) return;
      src = c.createBufferSource();
      src.buffer = buf;
      src.loop = !!opts.loop;
      const g = (gain = c.createGain());
      g.gain.value = opts.volume ?? 1;
      src.connect(g).connect(out);
      src.start();
    });
  }
  return {
    stop(fade = 0) {
      if (stopped) return;
      stopped = true;
      try {
        if (fade > 0 && ctx && gain && src) {
          const t = ctx.currentTime;
          gain.gain.setValueAtTime(gain.gain.value, t);
          gain.gain.linearRampToValueAtTime(0, t + fade);
          src.stop(t + fade + 0.02);
        } else src?.stop();
      } catch {
        /* already stopped */
      }
    },
  };
}
