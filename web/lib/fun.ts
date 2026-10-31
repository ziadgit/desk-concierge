// The Cardputer can only type and draw ASCII, so visitors type emoticons.
// Messages are stored exactly as typed; the inbox swaps emoticons for
// emoji at render time.
const EMOTICONS: [RegExp, string][] = [
  [/:-?\)/g, "🙂"],
  [/:-?D/g, "😄"],
  [/:-?\(/g, "🙁"],
  [/;-?\)/g, "😉"],
  [/:-?P/gi, "😛"],
  [/:-?O/g, "😮"],
  [/<3/g, "❤️"],
  [/\^_\^/g, "😊"],
];

export function emojify(text: string): string {
  return EMOTICONS.reduce((out, [pattern, emoji]) => out.replace(pattern, emoji), text);
}

export function isBoop(text: string): boolean {
  return /\bboop\b/i.test(text);
}

let ctx: AudioContext | null = null;

// Browsers only allow audio after a user gesture on the page. Call this
// from a click handler once; after that playBoop works from timers.
export function unlockAudio() {
  ctx ??= new AudioContext();
  void ctx.resume();
}

export function audioUnlocked() {
  return ctx?.state === "running";
}

// A bright two-note "boop": a pitch-dropping sine blip followed by a
// higher chime, with a little sparkle on top. Synthesized, so no sound
// file to ship.
export function playBoop() {
  if (!ctx || ctx.state !== "running") return;
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.35;
  master.connect(ctx.destination);

  const note = (freqStart: number, freqEnd: number, start: number, dur: number, type: OscillatorType, vol: number) => {
    const osc = ctx!.createOscillator();
    const gain = ctx!.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, now + start);
    osc.frequency.exponentialRampToValueAtTime(freqEnd, now + start + dur);
    gain.gain.setValueAtTime(0.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(vol, now + start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
    osc.connect(gain).connect(master);
    osc.start(now + start);
    osc.stop(now + start + dur + 0.05);
  };

  note(880, 220, 0, 0.18, "sine", 1);         // boo-
  note(660, 1320, 0.16, 0.22, "triangle", 0.8); // -op!
  note(2640, 3520, 0.2, 0.25, "sine", 0.15);   // sparkle
  note(1980, 2640, 0.28, 0.3, "sine", 0.1);
}
