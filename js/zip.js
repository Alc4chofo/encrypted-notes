// notes: A small ZIP writer, to hand over several files as one download.
"use strict";

// Stored entries only (no compression): what it packs is the app's own text
// files, and every unzip tool reads a stored ZIP. Names are UTF-8 (flag bit 11),
// folders come from the names themselves ("js/core.js"), and the date is now,
// in local time, as ZIP keeps it.
let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// entries: [{ name: "js/core.js", bytes: Uint8Array }] -> the archive, as a Blob.
function zipBlob(entries) {
  const enc = new TextEncoder(), now = new Date(), head = [], central = [];
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  let offset = 0;
  for (const { name, bytes } of entries) {
    const nb = enc.encode(name), crc = crc32(bytes), size = bytes.length;
    const local = new DataView(new ArrayBuffer(30));   // local file header
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);                       // needs version 2.0 to extract
    local.setUint16(6, 0x0800, true);                   // the name is UTF-8
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);                    // stored: packed size = size
    local.setUint32(22, size, true);
    local.setUint16(26, nb.length, true);
    head.push(local, nb, bytes);
    const entry = new DataView(new ArrayBuffer(46));    // its central directory entry
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, nb.length, true);
    entry.setUint32(42, offset, true);                  // where its local header starts
    central.push(entry, nb);
    offset += 30 + nb.length + size;
  }
  const dirSize = central.reduce((n, part) => n + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));        // end of central directory
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...head, ...central, end], { type: "application/zip" });
}
