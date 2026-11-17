/**
 * cowrite as-written (OSS-21): source-song notes as a plain House Band score.
 * One track holds every part; stand-in voices by role / GM drum map; timing via nudge.
 */
import { matchDrumTokens, tokenize } from '../samples/scan.mjs';
import { SPEC_LIMITS, validateSpec } from '../spec.mjs';
import { SCHEMA_VERSION, KIT_VERSION } from '../version.mjs';
import { validateSourceSong } from './source-song.mjs';

const MAX_BARS = 256; // SPEC_LIMITS.trackLength / 16
const NUDGE_MIN = -50;
const NUDGE_MAX = 50;

const ROLE_VOICE = Object.freeze({
  melody: 'lead',
  bass: 'bass',
  chords: 'pad',
  other: 'pluck',
});

const NOTE_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);

/** GM percussion note -> { voice, variant? }. Unlisted notes are not GM-mapped. */
const GM_DRUM = Object.freeze({
  35: { voice: 'kick' },
  36: { voice: 'kick' },
  37: { voice: 'rim' },
  38: { voice: 'snare' },
  39: { voice: 'clap' },
  40: { voice: 'snare' },
  41: { voice: 'tomLow' },
  42: { voice: 'hat' },
  43: { voice: 'tomLow' },
  44: { voice: 'hat' },
  45: { voice: 'tomMid' },
  46: { voice: 'hat', variant: 'open' },
  47: { voice: 'tomMid' },
  48: { voice: 'tomHigh' },
  49: { voice: 'crash' },
  50: { voice: 'tomHigh' },
  51: { voice: 'ride' },
  57: { voice: 'crash' },
  59: { voice: 'ride' },
});

export class AsWrittenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AsWrittenError';
  }
}

/**
 * MIDI number to note name accepted by noteFreq (e.g. C4, D#5).
 * @param {number} midi
 * @returns {string}
 */
export function midiToNoteName(midi) {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

/**
 * Map OSS-11 drum token match role to a score voice (+ optional variant).
 * @param {{ role: string } | null} match
 * @returns {{ voice: string, variant?: string }}
 */
function voiceFromDrumMatch(match) {
  if (!match) return { voice: 'perc' };
  const role = match.role;
  if (role === 'hat.open') return { voice: 'hat', variant: 'open' };
  if (role.startsWith('kick')) return { voice: 'kick' };
  if (role.startsWith('snare')) return { voice: 'snare' };
  if (role.startsWith('hat')) return { voice: 'hat' };
  if (role.startsWith('tomLow')) return { voice: 'tomLow' };
  if (role.startsWith('tomMid')) return { voice: 'tomMid' };
  if (role.startsWith('tomHigh')) return { voice: 'tomHigh' };
  if (role.startsWith('clap')) return { voice: 'clap' };
  if (role.startsWith('rim')) return { voice: 'rim' };
  if (role.startsWith('ride')) return { voice: 'ride' };
  if (role.startsWith('crash')) return { voice: 'crash' };
  if (role.startsWith('perc')) return { voice: 'perc' };
  return { voice: 'perc' };
}

/**
 * Drum voice from instrument / track name via the OSS-11 token table.
 * @param {string} name
 * @returns {{ voice: string, variant?: string }}
 */
export function drumVoiceFromInstrumentName(name) {
  return voiceFromDrumMatch(matchDrumTokens(tokenize(name || '')));
}

/**
 * Whether this drums track uses GM note numbers (MIDI) vs instrument-name mapping.
 * @param {{ instrumentName: string, kind: string }} track
 * @param {{ provenance?: { importer?: string } }} song
 */
function usesGmDrumNotes(track, song) {
  if (track.instrumentName === 'GM drums') return true;
  const importer = song?.provenance?.importer;
  return importer === 'midi';
}

/**
 * Resolve drum voice for one note.
 * @returns {{ voice: string, variant?: string }}
 */
export function resolveDrumVoice(track, note, song) {
  if (usesGmDrumNotes(track, song)) {
    return GM_DRUM[note.midi] ?? { voice: 'perc' };
  }
  const fromInstrument = drumVoiceFromInstrumentName(track.instrumentName);
  if (fromInstrument.voice !== 'perc' || matchDrumTokens(tokenize(track.instrumentName || ''))) {
    return fromInstrument;
  }
  const fromName = drumVoiceFromInstrumentName(track.name);
  return fromName;
}

/**
 * Step index and unclamped nudge (ms) for a note at `tempo` BPM.
 * @returns {{ i: number, nudgeMs: number }}
 */
export function noteTiming(beat, offsetMs, tempo) {
  const steps = beat * 4;
  const i = Math.round(steps);
  const residualSteps = steps - i;
  const stepMs = 60000 / tempo / 4;
  const nudgeMs = residualSteps * stepMs + (offsetMs || 0);
  return { i, nudgeMs };
}

function clampNudge(nudgeMs) {
  const clamped = Math.min(NUDGE_MAX, Math.max(NUDGE_MIN, nudgeMs));
  return { nudge: clamped, wasClamped: clamped !== nudgeMs };
}

/**
 * Build a validated as-written score from a source-song.
 * @param {object} sourceSong raw or already-validated source-song
 * @param {{ kit?: string }} [options]
 * @returns {{
 *   spec: object,
 *   bars: number,
 *   noteCount: number,
 *   clampedCount: number,
 *   messages: string[],
 * }}
 */
export function asWritten(sourceSong, options = {}) {
  const song = validateSourceSong(
    typeof sourceSong === 'object' && sourceSong !== null
      ? JSON.parse(JSON.stringify(sourceSong))
      : sourceSong,
  );
  const kit = options.kit ?? 'tr808';
  const messages = [];

  const tempo = song.tempoMap[0].bpm;
  if (song.tempoMap.length > 1) {
    const ignored = song.tempoMap.length - 1;
    messages.push(`tempo map flattened to ${tempo} BPM (${ignored} changes ignored)`);
  }

  const [num, den] = song.timeSignature;
  if (num !== 4 || den !== 4) {
    messages.push(`time signature ${num}/${den} laid on 16-step bars`);
  }

  const bars = Math.ceil(song.lengthBeats / 4);
  const len = bars * 16;
  let noteCount = 0;
  for (const t of song.tracks) noteCount += t.notes.length;

  if (len > SPEC_LIMITS.trackLength || noteCount > SPEC_LIMITS.stepsPerTrack || bars > MAX_BARS) {
    throw new AsWrittenError(
      `as-written v1 limit: ${bars} bars / ${noteCount} notes (max ${MAX_BARS} bars, ${SPEC_LIMITS.stepsPerTrack} notes)`,
    );
  }

  const steps = [];
  let clampedCount = 0;

  for (const track of song.tracks) {
    const isDrums = track.kind === 'drums' || track.roleGuess === 'drums';
    for (const note of track.notes) {
      const { i, nudgeMs } = noteTiming(note.beat, note.offsetMs, tempo);
      const { nudge, wasClamped } = clampNudge(nudgeMs);
      if (wasClamped) clampedCount += 1;

      if (isDrums) {
        const { voice, variant } = resolveDrumVoice(track, note, song);
        const opts = { vol: 0.25 * note.velocity };
        if (variant) opts.variant = variant;
        const event = { i, voice, opts };
        if (nudge !== 0) event.nudge = nudge;
        steps.push(event);
      } else {
        const voice = ROLE_VOICE[track.roleGuess] ?? 'pluck';
        let dur = (note.lengthBeats * 60) / tempo;
        if (dur > SPEC_LIMITS.eventDuration) dur = SPEC_LIMITS.eventDuration;
        if (dur < 0.001) dur = 0.001;
        const event = {
          i,
          voice,
          note: midiToNoteName(note.midi),
          dur,
          opts: { vol: 0.12 * note.velocity },
        };
        if (nudge !== 0) event.nudge = nudge;
        steps.push(event);
      }
    }
  }

  if (clampedCount > 0) {
    messages.push(`nudge clamped: ${clampedCount} notes`);
  }

  const raw = {
    schemaVersion: SCHEMA_VERSION,
    kitVersion: { semver: KIT_VERSION.semver, sha: KIT_VERSION.sha },
    seed: 1,
    tempo,
    sampleRate: 44100,
    gain: 0.5,
    label: `As written: ${song.title}`,
    register: { name: 'as-written', briefRef: 'docs/CO-WRITE.md' },
    kit,
    tracks: {
      song: {
        bpm: tempo,
        vol: 0.8,
        len,
        steps,
      },
    },
    sections: [{ track: 'song', bars, fadeIn: 0.01 }],
  };

  const spec = validateSpec(raw);
  return { spec, bars, noteCount, clampedCount, messages };
}
