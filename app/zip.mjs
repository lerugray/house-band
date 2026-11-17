/** Minimal ZIP writer: UTF-8 names, stored entries, no compression. */

const encoder = new TextEncoder();

function bytes(value) {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('ZIP entry data must be a string, ArrayBuffer, or typed array');
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function concat(parts) {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function createZip(entries, opts = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('ZIP needs at least one entry');
  if (entries.length > 0xffff) throw new Error('ZIP entry limit exceeded');
  const date = opts.date instanceof Date ? opts.date : new Date();
  const stamp = dosDateTime(date);
  const names = new Set();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name.includes('\\') || entry.name.startsWith('/') || entry.name.split('/').includes('..')) {
      throw new Error('ZIP entry needs a safe relative name');
    }
    if (names.has(entry.name)) throw new Error(`duplicate ZIP entry: ${entry.name}`);
    names.add(entry.name);
    const name = encoder.encode(entry.name);
    const data = bytes(entry.data);
    const checksum = crc32(data);
    const flags = 0x0800;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    writeU32(lv, 0, 0x04034b50);
    writeU16(lv, 4, 20);
    writeU16(lv, 6, flags);
    writeU16(lv, 8, 0);
    writeU16(lv, 10, stamp.time);
    writeU16(lv, 12, stamp.date);
    writeU32(lv, 14, checksum);
    writeU32(lv, 18, data.byteLength);
    writeU32(lv, 22, data.byteLength);
    writeU16(lv, 26, name.length);
    writeU16(lv, 28, 0);
    local.set(name, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    writeU32(cv, 0, 0x02014b50);
    writeU16(cv, 4, 20);
    writeU16(cv, 6, 20);
    writeU16(cv, 8, flags);
    writeU16(cv, 10, 0);
    writeU16(cv, 12, stamp.time);
    writeU16(cv, 14, stamp.date);
    writeU32(cv, 16, checksum);
    writeU32(cv, 20, data.byteLength);
    writeU32(cv, 24, data.byteLength);
    writeU16(cv, 28, name.length);
    writeU16(cv, 30, 0);
    writeU16(cv, 32, 0);
    writeU16(cv, 34, 0);
    writeU16(cv, 36, 0);
    writeU32(cv, 38, 0);
    writeU32(cv, 42, localOffset);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.byteLength + data.byteLength;
  }

  const central = concat(centralParts);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  writeU32(ev, 0, 0x06054b50);
  writeU16(ev, 4, 0);
  writeU16(ev, 6, 0);
  writeU16(ev, 8, entries.length);
  writeU16(ev, 10, entries.length);
  writeU32(ev, 12, central.byteLength);
  writeU32(ev, 16, localOffset);
  writeU16(ev, 20, 0);
  return concat([...localParts, central, end]);
}

/** Read stored entries produced by createZip (used by suite verification). */
export function readStoredZip(zip) {
  const data = bytes(zip);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder();
  const out = new Map();
  let offset = 0;
  while (offset + 4 <= data.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    if (method !== 0) throw new Error('only stored ZIP entries are supported');
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const payloadStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(data.subarray(nameStart, nameStart + nameLength));
    out.set(name, data.slice(payloadStart, payloadStart + size));
    offset = payloadStart + size;
  }
  return out;
}
