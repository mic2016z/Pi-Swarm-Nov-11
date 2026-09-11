// A distinct tone per agent, played when that agent finishes work and goes idle,
// so the squad can be followed without watching the panes.
//
// Tones are synthesised rather than loaded: the app's CSP allows no external
// media, and a short oscillator note needs no asset.

// Notes of a C major triad plus the octave, so several agents finishing close
// together sound like a chord rather than a clash.
const TONES = [
  { match: 'master', frequency: 523.25 }, // C5
  { match: 'oc-1', frequency: 659.25 },   // E5
  { match: 'oc-2', frequency: 783.99 },   // G5
  { match: 'oc-3', frequency: 1046.5 },   // C6
];
// Anything beyond the named agents keeps rising in whole steps so it stays distinct.
const EXTRA_BASE = 1174.7;

let context = null;
let enabled = true;

function frequencyFor(id) {
  const known = TONES.find((tone) => tone.match === id);
  if (known) return known.frequency;
  const number = Number(/^oc-(\d+)$/.exec(id)?.[1]);
  return Number.isFinite(number) ? EXTRA_BASE * Math.pow(2, (number - 4) / 12) : 880;
}

function audio() {
  if (context) return context;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try { context = new Ctor(); } catch { return null; }
  return context;
}

/** One short note with a soft attack and release; a raw gate would click. */
function play(frequency) {
  const ctx = audio();
  if (!ctx || !enabled) return;
  // Autoplay policy suspends the context until a gesture; resume is a no-op otherwise.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const now = ctx.currentTime;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, now);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.14, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.45);
}

const previous = new Map();

/**
 * Announce a status for one agent, sounding its tone only on the transition
 * into idle. Repeated idle reports stay silent, so the 2.5s poll cannot chime.
 */
export function announceAgentStatus(id, status) {
  const now = String(status || '').toLowerCase();
  const before = previous.get(id);
  previous.set(id, now);
  if (before === undefined) return; // First observation is state, not a transition.
  const wasWorking = ['busy', 'working', 'starting'].includes(before);
  const isIdle = ['idle', 'registered'].includes(now);
  if (wasWorking && isIdle) play(frequencyFor(id));
}

export function forgetAgentStatuses() {
  previous.clear();
}

export function installAgentTones() {
  const button = document.createElement('button');
  button.className = 'btn';
  button.id = 'btn-tones';
  button.className = 'btn icon';
  button.textContent = '🔔';
  button.title = 'Play a distinct tone when an agent finishes work';
  button.setAttribute('aria-pressed', 'true');
  button.addEventListener('click', () => {
    enabled = !enabled;
    button.textContent = enabled ? '🔔' : '🔕';
    button.setAttribute('aria-pressed', String(enabled));
    if (enabled) play(frequencyFor('master')); // Confirm audibly that it is back on.
  });
  document.querySelector('.bar-actions')?.appendChild(button);
  // A gesture anywhere unlocks audio for the rest of the session.
  window.addEventListener('pointerdown', () => { const ctx = audio(); if (ctx?.state === 'suspended') ctx.resume().catch(() => {}); }, { once: true });
}
