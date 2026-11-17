/**
 * Encode an AudioBuffer (or channel Float32Arrays) as 16-bit PCM WAV bytes.
 */

/**
 * @param {AudioBuffer | { sampleRate: number, numberOfChannels: number, getChannelData: (c:number)=>Float32Array, length: number }} buffer
 * @returns {Buffer}
 */
export function encodeWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  const channels = [];
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let s = channels[c][i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      // 16-bit PCM: scale to int16 range
      const v = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
      buf.writeInt16LE(v, offset);
      offset += 2;
    }
  }
  return buf;
}

/** Read basic WAV header fields (for tests). */
export function readWavHeader(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 44) throw new Error('WAV too short for header');
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('missing RIFF');
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('missing WAVE');
  if (buf.toString('ascii', 12, 16) !== 'fmt ') throw new Error('missing fmt');
  return {
    audioFormat: buf.readUInt16LE(20),
    numChannels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    byteRate: buf.readUInt32LE(28),
    blockAlign: buf.readUInt16LE(32),
    bitsPerSample: buf.readUInt16LE(34),
    dataSize: buf.readUInt32LE(40),
    fileSize: buf.length,
  };
}
