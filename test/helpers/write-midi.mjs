/**
 * Minimal SMF writer for OSS-17 fixtures (types 0 and 1, PPQ).
 */

export const FIXTURE = Object.freeze({
  title: 'fixture',
  ppq: 480,
  tempo: 120,
  timeSignature: Object.freeze([4, 4]),
  /** Shared musical fixture: 4/4, 120 BPM, 2 bars. */
  melody: Object.freeze([
    { beat: 0, lengthBeats: 1, midi: 72, velocity: 100 }, // C5
    { beat: 1, lengthBeats: 1, midi: 76, velocity: 100 }, // E5
    { beat: 2, lengthBeats: 1, midi: 79, velocity: 100 }, // G5
    { beat: 3, lengthBeats: 1, midi: 84, velocity: 100 }, // C6
    { beat: 4, lengthBeats: 2, midi: 74, velocity: 100 }, // D5
    { beat: 6, lengthBeats: 2, midi: 71, velocity: 100 }, // B4
  ]),
  bass: Object.freeze([
    { beat: 0, lengthBeats: 4, midi: 48, velocity: 100 }, // C3
    { beat: 4, lengthBeats: 4, midi: 43, velocity: 100 }, // G2
  ]),
  drums: Object.freeze([
    { beat: 0, lengthBeats: 0.5, midi: 36, velocity: 100 },
    { beat: 1, lengthBeats: 0.5, midi: 38, velocity: 100 },
    { beat: 2, lengthBeats: 0.5, midi: 36, velocity: 100 },
    { beat: 3, lengthBeats: 0.5, midi: 38, velocity: 100 },
    { beat: 4, lengthBeats: 0.5, midi: 36, velocity: 100 },
    { beat: 5, lengthBeats: 0.5, midi: 38, velocity: 100 },
    { beat: 6, lengthBeats: 0.5, midi: 36, velocity: 100 },
    { beat: 7, lengthBeats: 0.5, midi: 38, velocity: 100 },
  ]),
});

function writeVarLen(value) {
  const bytes = [];
  let buffer = value & 0x7f;
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  for (;;) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return Buffer.from(bytes);
}

function meta(type, data) {
  return Buffer.concat([
    Buffer.from([0xff, type]),
    writeVarLen(data.length),
    Buffer.from(data),
  ]);
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

/**
 * Build a track from absolute-tick events: [{ tick, bytes (Buffer), runningEligible? }]
 * @param {{ tick: number, bytes: Buffer, status?: number }[]} events
 * @param {{ useRunningStatus?: boolean }} [opts]
 */
function encodeTrack(events, opts = {}) {
  const sorted = [...events].sort((a, b) => a.tick - b.tick);
  const parts = [];
  let lastTick = 0;
  let lastStatus = null;
  for (const ev of sorted) {
    const delta = ev.tick - lastTick;
    lastTick = ev.tick;
    parts.push(writeVarLen(delta));
    let body = ev.bytes;
    if (
      opts.useRunningStatus &&
      ev.status != null &&
      ev.status === lastStatus &&
      ev.status < 0xf0
    ) {
      body = body.subarray(1);
    } else if (ev.status != null && ev.status < 0xf0) {
      lastStatus = ev.status;
    } else if (ev.status === 0xff || ev.status === 0xf0 || ev.status === 0xf7) {
      lastStatus = null;
    }
    parts.push(body);
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.write('MTrk', 0, 4, 'ascii');
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function noteEvents(notes, channel, ppq, program = null) {
  const events = [];
  if (program != null) {
    const status = 0xc0 | (channel & 0x0f);
    events.push({
      tick: 0,
      status,
      bytes: Buffer.from([status, program & 0x7f]),
    });
  }
  for (const n of notes) {
    const onStatus = 0x90 | (channel & 0x0f);
    const offStatus = 0x80 | (channel & 0x0f);
    const start = Math.round(n.beat * ppq);
    const end = Math.round((n.beat + n.lengthBeats) * ppq);
    const vel = n.velocity ?? 100;
    events.push({
      tick: start,
      status: onStatus,
      bytes: Buffer.from([onStatus, n.midi & 0x7f, vel & 0x7f]),
    });
    events.push({
      tick: end,
      status: offStatus,
      bytes: Buffer.from([offStatus, n.midi & 0x7f, 0x40]),
    });
  }
  return events;
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

/**
 * @typedef {object} WriteMidiOptions
 * @property {0|1} [format]
 * @property {number} [ppq]
 * @property {number} [tempo]
 * @property {[number, number]} [timeSignature]
 * @property {{ beat: number, bpm: number }[]} [tempoChanges] extra tempos (beat 0 is the initial tempo)
 * @property {boolean} [useRunningStatus]
 * @property {boolean} [insertSysex] insert a harmless sysex early in the melody/data track
 * @property {object[]} [melody]
 * @property {object[]} [bass]
 * @property {object[]} [drums]
 * @property {string} [melodyName]
 * @property {string} [bassName]
 * @property {string} [drumsName]
 */

/**
 * Write the shared musical fixture (or overrides) as an SMF Buffer.
 * @param {WriteMidiOptions} [opts]
 * @returns {Buffer}
 */
export function writeMidi(opts = {}) {
  const format = opts.format == null ? 1 : opts.format;
  const ppq = opts.ppq ?? FIXTURE.ppq;
  const tempo = opts.tempo ?? FIXTURE.tempo;
  const timeSignature = opts.timeSignature ?? FIXTURE.timeSignature;
  const melody = opts.melody ?? FIXTURE.melody;
  const bass = opts.bass ?? FIXTURE.bass;
  const drums = opts.drums ?? FIXTURE.drums;
  const useRunningStatus = Boolean(opts.useRunningStatus);
  const insertSysex = Boolean(opts.insertSysex);
  const tempoChanges = opts.tempoChanges ?? [];

  const tempoEvents = [
    { tick: 0, status: 0xff, bytes: tempoMeta(tempo) },
    { tick: 0, status: 0xff, bytes: timeSigMeta(timeSignature[0], timeSignature[1]) },
  ];
  for (const tc of tempoChanges) {
    tempoEvents.push({
      tick: Math.round(tc.beat * ppq),
      status: 0xff,
      bytes: tempoMeta(tc.bpm),
    });
  }
  // End conductor a bit after song
  tempoEvents.push({ tick: Math.round(8 * ppq), status: 0xff, bytes: endOfTrack() });

  const sysexEvent = insertSysex
    ? {
        tick: 0,
        status: 0xf0,
        // F0 + VLQ(len=4) + 00 01 02 F7
        bytes: Buffer.from([0xf0, 0x04, 0x00, 0x01, 0x02, 0xf7]),
      }
    : null;

  const named = (label) =>
    label ? [{ tick: 0, status: 0xff, bytes: trackNameMeta(label) }] : [];

  if (format === 0) {
    const events = [
      ...tempoEvents.filter((e) => e.bytes[1] !== 0x2f),
      ...(sysexEvent ? [sysexEvent] : []),
      // No track name by default so type 0/1 tracks match aside from ids.
      ...named(opts.melodyName),
      ...noteEvents(melody, 0, ppq, 80), // Lead 1 (square)
      ...noteEvents(bass, 1, ppq, 32), // Acoustic Bass
      ...noteEvents(drums, 9, ppq, null),
      { tick: Math.round(8 * ppq), status: 0xff, bytes: endOfTrack() },
    ];
    return Buffer.concat([
      headerChunk(0, 1, ppq),
      encodeTrack(events, { useRunningStatus }),
    ]);
  }

  // Type 1: tempo track + 3 music tracks
  const conductor = encodeTrack(tempoEvents);
  const melEvents = [
    ...named(opts.melodyName),
    ...(sysexEvent ? [sysexEvent] : []),
    ...noteEvents(melody, 0, ppq, 80),
    { tick: Math.round(8 * ppq), status: 0xff, bytes: endOfTrack() },
  ];
  const bassEvents = [
    ...named(opts.bassName),
    ...noteEvents(bass, 0, ppq, 32),
    { tick: Math.round(8 * ppq), status: 0xff, bytes: endOfTrack() },
  ];
  const drumEvents = [
    ...named(opts.drumsName),
    ...noteEvents(drums, 9, ppq, null),
    { tick: Math.round(8 * ppq), status: 0xff, bytes: endOfTrack() },
  ];

  return Buffer.concat([
    headerChunk(1, 4, ppq),
    conductor,
    encodeTrack(melEvents, { useRunningStatus }),
    encodeTrack(bassEvents, { useRunningStatus }),
    encodeTrack(drumEvents, { useRunningStatus }),
  ]);
}

/** Convenience: type-1 fixture bytes. */
export function writeFixtureType1(opts = {}) {
  return writeMidi({ ...opts, format: 1 });
}

/** Convenience: type-0 fixture bytes. */
export function writeFixtureType0(opts = {}) {
  return writeMidi({ ...opts, format: 0 });
}
