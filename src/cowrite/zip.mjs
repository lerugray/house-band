/**
 * Minimal ZIP reader/writer (OSS-18). No dependencies.
 * Read: central directory; extract stored or deflate (zlib.inflateRawSync).
 * Write: stored members only.
 */
import { inflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** CRC-32 (ISO 3309 / ZIP). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function readUint16LE(buf, offset) {
  return buf[offset] | (buf[offset + 1] << 8);
}

function readUint32LE(buf, offset) {
  return (
    (buf[offset] |
      (buf[offset + 1] << 8) |
      (buf[offset + 2] << 16) |
      (buf[offset + 3] << 24)) >>>
    0
  );
}

function writeUint16LE(buf, offset, value) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32LE(buf, offset, value) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function findEocd(buf) {
  // EOCD is at least 22 bytes; comment can extend it.
  const min = 22;
  if (buf.length < min) throw new Error('zip too short');
  const start = Math.max(0, buf.length - (min + 0xffff));
  for (let i = buf.length - min; i >= start; i--) {
    if (readUint32LE(buf, i) === SIG_EOCD) return i;
  }
  throw new Error('zip end of central directory not found');
}

/**
 * @typedef {{ name: string, method: number, compressedSize: number, uncompressedSize: number,
 *   crc32: number, localHeaderOffset: number, centralOffset: number }} ZipEntry
 */

/**
 * Read the ZIP central directory.
 * @param {Uint8Array|Buffer} bytes
 * @returns {ZipEntry[]}
 */
export function readCentralDirectory(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const eocd = findEocd(buf);
  const entryCount = readUint16LE(buf, eocd + 10);
  const cdSize = readUint32LE(buf, eocd + 12);
  const cdOffset = readUint32LE(buf, eocd + 16);
  if (cdOffset + cdSize > buf.length) throw new Error('zip central directory truncated');

  const entries = [];
  let offset = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buf.length) throw new Error('zip central directory truncated');
    if (readUint32LE(buf, offset) !== SIG_CENTRAL) {
      throw new Error('zip bad central directory signature');
    }
    const method = readUint16LE(buf, offset + 10);
    const crc = readUint32LE(buf, offset + 16);
    const compressedSize = readUint32LE(buf, offset + 20);
    const uncompressedSize = readUint32LE(buf, offset + 24);
    const nameLen = readUint16LE(buf, offset + 28);
    const extraLen = readUint16LE(buf, offset + 30);
    const commentLen = readUint16LE(buf, offset + 32);
    const localHeaderOffset = readUint32LE(buf, offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd + extraLen + commentLen > buf.length) {
      throw new Error('zip central directory truncated');
    }
    let name = '';
    for (let j = nameStart; j < nameEnd; j++) name += String.fromCharCode(buf[j]);
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      crc32: crc,
      localHeaderOffset,
      centralOffset: offset,
    });
    offset = nameEnd + extraLen + commentLen;
  }
  return entries;
}

/**
 * Extract one member by name. Returns uncompressed bytes.
 * @param {Uint8Array|Buffer} bytes
 * @param {string} memberName
 * @returns {Uint8Array}
 */
export function extractMember(bytes, memberName) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const entries = readCentralDirectory(buf);
  const entry = entries.find((e) => e.name === memberName);
  if (!entry) throw new Error(`zip member not found: ${memberName}`);

  const lh = entry.localHeaderOffset;
  if (lh + 30 > buf.length) throw new Error('zip local header truncated');
  if (readUint32LE(buf, lh) !== SIG_LOCAL) throw new Error('zip bad local header signature');
  const method = readUint16LE(buf, lh + 8);
  const nameLen = readUint16LE(buf, lh + 26);
  const extraLen = readUint16LE(buf, lh + 28);
  // Prefer local sizes when non-zero; else central (data descriptor case).
  let compressedSize = readUint32LE(buf, lh + 18);
  if (compressedSize === 0) compressedSize = entry.compressedSize;
  const dataStart = lh + 30 + nameLen + extraLen;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > buf.length) throw new Error('zip member data truncated');
  const compressed = buf.subarray(dataStart, dataEnd);
  const useMethod = method === METHOD_STORED || method === METHOD_DEFLATE ? method : entry.method;
  if (useMethod === METHOD_STORED) {
    return new Uint8Array(compressed);
  }
  if (useMethod === METHOD_DEFLATE) {
    const out = inflateRawSync(Buffer.from(compressed));
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }
  throw new Error(`zip unsupported compression method ${useMethod}`);
}

/**
 * List member names from the central directory.
 * @param {Uint8Array|Buffer} bytes
 * @returns {string[]}
 */
export function listMembers(bytes) {
  return readCentralDirectory(bytes).map((e) => e.name);
}

/**
 * Write a ZIP archive with stored (uncompressed) members.
 * @param {{ name: string, data: Uint8Array|Buffer }[]} members
 * @returns {Uint8Array}
 */
export function writeZipStored(members) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const member of members) {
    const nameBytes = Buffer.from(member.name, 'utf8');
    const data =
      member.data instanceof Uint8Array
        ? member.data
        : new Uint8Array(member.data);
    const checksum = crc32(data);
    const size = data.length;

    const local = Buffer.alloc(30 + nameBytes.length);
    writeUint32LE(local, 0, SIG_LOCAL);
    writeUint16LE(local, 4, 20); // version needed
    writeUint16LE(local, 6, 0); // flags
    writeUint16LE(local, 8, METHOD_STORED);
    writeUint16LE(local, 10, 0); // time
    writeUint16LE(local, 12, 0); // date
    writeUint32LE(local, 14, checksum);
    writeUint32LE(local, 18, size);
    writeUint32LE(local, 22, size);
    writeUint16LE(local, 26, nameBytes.length);
    writeUint16LE(local, 28, 0); // extra
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    writeUint32LE(central, 0, SIG_CENTRAL);
    writeUint16LE(central, 4, 20); // version made by
    writeUint16LE(central, 6, 20); // version needed
    writeUint16LE(central, 8, 0); // flags
    writeUint16LE(central, 10, METHOD_STORED);
    writeUint16LE(central, 12, 0); // time
    writeUint16LE(central, 14, 0); // date
    writeUint32LE(central, 16, checksum);
    writeUint32LE(central, 20, size);
    writeUint32LE(central, 24, size);
    writeUint16LE(central, 28, nameBytes.length);
    writeUint16LE(central, 30, 0); // extra
    writeUint16LE(central, 32, 0); // comment
    writeUint16LE(central, 34, 0); // disk start
    writeUint16LE(central, 36, 0); // int attrs
    writeUint32LE(central, 38, 0); // ext attrs
    writeUint32LE(central, 40, offset);
    nameBytes.copy(central, 46);

    localParts.push(local, Buffer.from(data));
    centralParts.push(central);
    offset += local.length + size;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  writeUint32LE(eocd, 0, SIG_EOCD);
  writeUint16LE(eocd, 4, 0);
  writeUint16LE(eocd, 6, 0);
  writeUint16LE(eocd, 8, members.length);
  writeUint16LE(eocd, 10, members.length);
  writeUint32LE(eocd, 12, centralDir.length);
  writeUint32LE(eocd, 16, offset);
  writeUint16LE(eocd, 20, 0);

  const out = Buffer.concat([...localParts, centralDir, eocd]);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
