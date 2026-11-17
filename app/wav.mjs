/**
 * Browser WAV encoder: 16-bit stereo PCM using DataView.
 * Mirrors src/wav.mjs but avoids Node-only Buffer.
 */

/**
 * @param {AudioBuffer} buffer
 * @returns {ArrayBuffer}
 */
export function encodeWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;

  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let s = channels[c][i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      const v = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
      view.setInt16(offset, v, true);
      offset += 2;
    }
  }
  return out;
}

/** Read basic WAV header fields (for tests). */
export function readWavHeader(bytes) {
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer;
  const view = new DataView(buf);
  const readString = (offset, len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
    return s;
  };
  if (readString(0, 4) !== 'RIFF') throw new Error('missing RIFF');
  if (readString(8, 4) !== 'WAVE') throw new Error('missing WAVE');
  if (readString(12, 4) !== 'fmt ') throw new Error('missing fmt');
  return {
    audioFormat: view.getUint16(20, true),
    numChannels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    dataSize: view.getUint32(40, true),
    fileSize: buf.byteLength,
  };
}
