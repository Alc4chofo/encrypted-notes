/*
 * zip.js - a small ZIP writer, to hand over several files as one download.
 *
 * Entries are stored, not compressed: what it packs is the app's own text
 * files, and every unzip tool reads a stored ZIP. Names are UTF-8 (flag bit
 * 11), folders come from the names themselves ("js/core.js"), and the date
 * is now, in local time, as ZIP keeps it.
 *
 * Main functions: zipBlob.
 * Auxiliary functions: crc32.
 *
 * Complexity: O(n) in the total size of the files (one CRC-32 pass each);
 * the bytes themselves are not copied, the Blob refers to them.
 */
"use strict";

// The CRC-32 lookup table, built on first use.
let crcTable = null;

/**
 * Packs files into one ZIP archive. entries: [{ name: "js/core.js", bytes:
 * Uint8Array }]. Returns the archive as a Blob: each file's local header and
 * bytes, then the central directory, then its end record.
 *
 * Used by: updates.js (an app update downloaded as one ZIP when the browser
 * cannot write to the app's folder).
 * Uses: crc32.
 * Complexity: O(n) in the total size.
 */
function zipBlob(entries) {
  const encoder = new TextEncoder();
  const now = new Date();
  const head = [];
  const central = [];
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  let offset = 0;

  for (const { name, bytes } of entries) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(bytes);
    const size = bytes.length;

    // The local file header.
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    // Needs version 2.0 to extract.
    local.setUint16(4, 20, true);
    // The name is UTF-8.
    local.setUint16(6, 0x0800, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    // Stored: the packed size is the size.
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    head.push(local, nameBytes, bytes);

    // Its entry in the central directory.
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, nameBytes.length, true);
    // Where its local header starts.
    entry.setUint32(42, offset, true);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + size;
  }

  // The end of the central directory.
  const directorySize = central.reduce((total, part) => total + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new Blob([...head, ...central, end], { type: "application/zip" });
}

// =================== Auxiliary functions ===================

/** The CRC-32 checksum ZIP stores for each file (IEEE polynomial, table-driven). Complexity: O(n). */
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
