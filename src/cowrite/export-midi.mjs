/**
 * Arrangement MIDI export (OSS-23): SMF type 1, PPQ 480, one track per score track.
 */
import { noteToMidi } from '../kit/band.js';

export const MIDI_PPQ = 480;
export const ARRANGEMENT_MIDI_FORMAT = 1;

/** GM program numbers as written in the card (1-based). MIDI bytes are n - 1. */
export const GM_PROGRAM_BY_VOICE = Object.freeze({
  lead: 81,
  bass: 34,
  pad: 89,
  pluck: 25,
  bell: 12,
  drone: 90,
});

/** House Band drum voice (+ hat open variant) -> GM percussion note. */
export const GM_DRUM_NOTE = Object.freeze({
  kick: 36,
  snare: 38,
  hat: 42,
  'hat:open': 46,
  tomLow: 41,
  tomMid: 45,
  tomHigh: 48,
  clap: 39,
  rim: 37,
  ride: 51,
  crash: 49,
  perc: 56,
});

/** Melodic MIDI channels in card order (1-based): 1-9 then 11-16. */
const MELODIC_CHANNELS_1BASED = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16]);
const DRUM_CHANNEL_1BASED = 10;

function writeVarLen(value) {
  const bytes = [];
  let v = value >>> 0;
  let buffer = v & 0x7f;
  while ((v >>= 7)) {
    buffer <<= 8;
    buffer |= (v & 0x7f) | 0x80;
  }
  for (;;) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return Buffer.from(bytes);
}

function meta(type, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([Buffer.from([0xff, type]), writeVarLen(payload.length), payload]);
}

function tempoMeta(bpm) {
  const us = Math.round(60_000_000 / bpm);
  return meta(0x51, [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]);
}

function timeSigMeta(num, den) {
  let denPow = 0;
  let d = den;
  while (d > 1) {
    d >>= 1;
    denPow += 1;
  }
  return meta(0x58, [num, denPow, 24, 8]);
}

function trackNameMeta(name) {
  return meta(0x03, Buffer.from(String(name), 'ascii'));
}

function endOfTrack() {
  return meta(0x2f, []);
}

function encodeTrack(events) {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
  const parts = [];
  let lastTick = 0;
  for (const ev of sorted) {
    parts.push(writeVarLen(Math.max(0, ev.tick - lastTick)));
    lastTick = ev.tick;
    parts.push(ev.bytes);
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.write('MTrk', 0, 4, 'ascii');
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function headerChunk(format, nTracks, ppq) {
  const buf = Buffer.alloc(14);
  buf.write('MThd', 0, 4, 'ascii');
  buf.writeUInt32BE(6, 4);
  buf.writeUInt16BE(format, 8);
  buf.writeUInt16BE(nTracks, 10);
  buf.writeUInt16BE(ppq, 12);
  return buf;
}

function isDrumVoice(voice) {
  return Object.hasOwn(GM_DRUM_NOTE, voice) || voice === 'hat';
}

function drumMidi(voice, opts = {}) {
  if (voice === 'hat' && opts.variant === 'open') return GM_DRUM_NOTE['hat:open'];
  return GM_DRUM_NOTE[voice] ?? GM_DRUM_NOTE.perc;
}

function stepVelocity(step) {
  const vol = step.opts?.vol ?? 0.1;
  return Math.max(1, Math.min(127, Math.round(127 * Math.min(1, vol / 0.15))));
}

function stepLengthBeats(step, tempo) {
  if (step.dur != null && Number.isFinite(step.dur) && step.dur > 0) {
    return (step.dur * tempo) / 60;
  }
  // Drum hits and other undated steps: one sixteenth.
  return 0.25;
}

/**
 * Majority origin over pitched steps (steps with a note); fall back to all steps.
 * Tie or empty -> "yours" when any user step exists, else "added".
 */
export function majorityOriginLabel(steps) {
  const pitched = steps.filter((s) => s.note);
  const pool = pitched.length > 0 ? pitched : steps;
  let user = 0;
  let hb = 0;
  for (const s of pool) {
    if (s.origin === 'user') user += 1;
    else if (s.origin === 'house-band') hb += 1;
  }
  if (user === 0 && hb === 0) {
    return steps.some((s) => s.origin === 'user') ? 'yours' : 'added';
  }
  if (user > hb) return 'yours';
  if (hb > user) return 'added';
  return steps.some((s) => s.origin === 'user') ? 'yours' : 'added';
}

function primaryVoice(steps) {
  const counts = new Map();
  for (const s of steps) {
    const v = s.voice ?? s.v;
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best = null;
  let n = -1;
  for (const [v, c] of counts) {
    if (c > n) {
      best = v;
      n = c;
    }
  }
  return best;
}

/**
 * Build arrangement.mid bytes from a developed score (and optional develop section starts).
 * Drum voices use MIDI channel 10; pitched voices use channels 1-9 and 11-16 in order
 * (one melodic channel per score track). Both may share one SMF track.
 * @param {object} spec validated house-band score
 * @param {{ sections?: { track: string, startBar: number, bars: number }[], timeSignature?: [number, number] }} [options]
 * @returns {Buffer}
 */
export function exportArrangementMidi(spec, options = {}) {
  const tempo = spec.tempo ?? 120;
  const ppq = MIDI_PPQ;
  const timeSignature = options.timeSignature ?? [4, 4];
  const [tsNum, tsDen] = timeSignature;
  const beatsPerBar = tsNum * (4 / tsDen);

  const startBarByTrack = new Map();
  const sectionList = options.sections ?? [];
  if (sectionList.length > 0) {
    for (const s of sectionList) startBarByTrack.set(s.track, s.startBar ?? 0);
  } else {
    let bar = 0;
    for (const s of spec.sections ?? []) {
      startBarByTrack.set(s.track, bar);
      bar += s.bars;
    }
  }

  const trackNames = (spec.sections ?? []).map((s) => s.track);
  for (const name of Object.keys(spec.tracks ?? {})) {
    if (!trackNames.includes(name)) trackNames.push(name);
  }

  const melodicChannelQueue = [...MELODIC_CHANNELS_1BASED];
  const drumChannel = (DRUM_CHANNEL_1BASED - 1) & 0x0f;
  const musicTracks = [];
  let order = 0;

  for (const trackName of trackNames) {
    const track = spec.tracks[trackName];
    if (!track?.steps?.length) continue;
    const steps = track.steps;
    const label = majorityOriginLabel(steps);
    const midiName = `${trackName} (${label})`;
    const pitched = steps.filter((s) => s.note && !isDrumVoice(s.voice ?? s.v));
    const hasPitched = pitched.length > 0;
    const melodicChannel1 = hasPitched ? (melodicChannelQueue.shift() ?? 16) : null;
    const melodicChannel = melodicChannel1 != null ? (melodicChannel1 - 1) & 0x0f : null;
    const startBar = startBarByTrack.get(trackName) ?? 0;
    const startBeat = startBar * beatsPerBar;
    const events = [];
    events.push({ tick: 0, order: order++, bytes: trackNameMeta(midiName) });

    if (melodicChannel != null) {
      // Prefer lead when present so the user's melody keeps a lead GM program.
      const voice = pitched.some((s) => (s.voice ?? s.v) === 'lead')
        ? 'lead'
        : (primaryVoice(pitched) ?? 'lead');
      const program1 = GM_PROGRAM_BY_VOICE[voice] ?? GM_PROGRAM_BY_VOICE.lead;
      const status = 0xc0 | melodicChannel;
      events.push({ tick: 0, order: order++, bytes: Buffer.from([status, (program1 - 1) & 0x7f]) });
    }

    for (const step of steps) {
      const voice = step.voice ?? step.v;
      const beat = startBeat + (step.i ?? 0) / 4;
      const startTick = Math.round(beat * ppq);
      const lengthBeats = stepLengthBeats(step, tempo);
      const endTick = Math.max(startTick + 1, Math.round((beat + lengthBeats) * ppq));
      const vel = stepVelocity(step);
      let midi;
      let channel;
      if (isDrumVoice(voice)) {
        midi = drumMidi(voice, step.opts ?? {});
        channel = drumChannel;
      } else if (step.note != null && melodicChannel != null) {
        midi = noteToMidi(step.note);
        if (midi == null) continue;
        channel = melodicChannel;
      } else {
        continue;
      }
      const onStatus = 0x90 | channel;
      const offStatus = 0x80 | channel;
      events.push({
        tick: startTick,
        order: order++,
        bytes: Buffer.from([onStatus, midi & 0x7f, vel & 0x7f]),
      });
      events.push({
        tick: endTick,
        order: order++,
        bytes: Buffer.from([offStatus, midi & 0x7f, 0x40]),
      });
    }

    const lastTick = events.reduce((m, e) => Math.max(m, e.tick), 0);
    events.push({ tick: lastTick, order: order++, bytes: endOfTrack() });
    musicTracks.push(encodeTrack(events));
  }

  const conductorEvents = [
    { tick: 0, order: 0, bytes: tempoMeta(tempo) },
    { tick: 0, order: 1, bytes: timeSigMeta(tsNum, tsDen) },
    { tick: 0, order: 2, bytes: endOfTrack() },
  ];
  const conductor = encodeTrack(conductorEvents);
  return Buffer.concat([
    headerChunk(ARRANGEMENT_MIDI_FORMAT, 1 + musicTracks.length, ppq),
    conductor,
    ...musicTracks,
  ]);
}
