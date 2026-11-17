/* Mandir Marg — minimal EXIF GPS reader (no dependencies)
 *
 * A geotagged phone photo carries the coordinates of the place it was taken.
 * Reading them saves the contributor from placing a pin by hand, and it is a
 * strong signal that the temple is really where they say it is.
 *
 * Only the JPEG APP1 "Exif" segment is inspected, and only the four GPS tags
 * needed for a position. Nothing is uploaded; the bytes never leave the page.
 *
 * Exposed as window.MandirMargExif so app.js can use it and so the parser can
 * be unit-tested outside a browser.
 */
(() => {
  "use strict";

  // Metadata sits at the start of a JPEG, so reading 256 KB is plenty and
  // keeps huge camera files out of memory.
  const MAX_HEADER_BYTES = 256 * 1024;
  const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  function readAscii(view, offset, count) {
    let text = "";
    for (let index = 0; index < count; index += 1) {
      const code = view.getUint8(offset + index);
      if (code === 0) break;
      text += String.fromCharCode(code);
    }
    return text;
  }

  function readIfdEntry(view, ifdOffset, tag, little, limit) {
    if (ifdOffset + 2 > limit) return null;
    const count = view.getUint16(ifdOffset, little);
    if (count > 512) return null;

    for (let index = 0; index < count; index += 1) {
      const entry = ifdOffset + 2 + index * 12;
      if (entry + 12 > limit) return null;
      if (view.getUint16(entry, little) === tag) {
        const type = view.getUint16(entry + 2, little);
        const items = view.getUint32(entry + 4, little);
        const size = (TYPE_SIZES[type] || 0) * items;
        if (!size) return null;
        return { type, count: items, size, valueOffset: entry + 8 };
      }
    }
    return null;
  }

  // Values of four bytes or less are stored inline in the entry itself.
  function valueOffset(view, tiffStart, entry, little, limit) {
    if (entry.size <= 4) return entry.valueOffset;
    const offset = tiffStart + view.getUint32(entry.valueOffset, little);
    return offset < limit ? offset : -1;
  }

  function readRationals(view, offset, count, little, limit) {
    if (offset < 0 || offset + count * 8 > limit) return null;
    const values = [];
    for (let index = 0; index < count; index += 1) {
      const at = offset + index * 8;
      const numerator = view.getUint32(at, little);
      const denominator = view.getUint32(at + 4, little);
      if (!denominator) return null;
      values.push(numerator / denominator);
    }
    return values;
  }

  function readCoordinate(view, tiffStart, gpsIfd, valueTag, refTag, little, limit) {
    const value = readIfdEntry(view, gpsIfd, valueTag, little, limit);
    const ref = readIfdEntry(view, gpsIfd, refTag, little, limit);
    if (!value || !ref || value.count < 3) return null;

    const parts = readRationals(
      view,
      valueOffset(view, tiffStart, value, little, limit),
      3,
      little,
      limit
    );
    if (!parts) return null;

    // Degrees, minutes, seconds. Some phones write fewer than three parts;
    // missing values simply contribute nothing.
    const degrees = parts[0] + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600;
    if (!Number.isFinite(degrees)) return null;

    const hemisphere = readAscii(view, ref.valueOffset, Math.min(ref.count, 4));
    return hemisphere === "S" || hemisphere === "W" ? -degrees : degrees;
  }

  function parseTiff(view, tiffStart) {
    if (tiffStart + 8 > view.byteLength) return null;

    const order = view.getUint16(tiffStart);
    let little;
    if (order === 0x4949) little = true;
    else if (order === 0x4d4d) little = false;
    else return null;

    if (view.getUint16(tiffStart + 2, little) !== 42) return null;

    const ifd0Offset = tiffStart + view.getUint32(tiffStart + 4, little);
    const pointer = readIfdEntry(view, ifd0Offset, 0x8825, little, view.byteLength);
    if (!pointer) return null;

    const gpsIfd = tiffStart + view.getUint32(pointer.valueOffset, little);
    if (gpsIfd + 2 > view.byteLength) return null;

    const lat = readCoordinate(view, tiffStart, gpsIfd, 2, 1, little, view.byteLength);
    const lng = readCoordinate(view, tiffStart, gpsIfd, 4, 3, little, view.byteLength);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    // 0,0 is the usual "GPS not fixed" placeholder, not the Gulf of Guinea.
    if (lat === 0 && lng === 0) return null;

    return { lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) };
  }

  function readGpsFromBuffer(buffer) {
    try {
      const view = new DataView(buffer);
      if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;

      let offset = 2;
      while (offset + 4 <= view.byteLength) {
        if (view.getUint8(offset) !== 0xff) return null;
        const marker = view.getUint16(offset);
        if (marker === 0xffd9 || marker === 0xffda) return null;

        const segmentLength = view.getUint16(offset + 2);
        if (segmentLength < 2) return null;

        if (marker === 0xffe1 && offset + 10 <= view.byteLength) {
          if (readAscii(view, offset + 4, 4) === "Exif") {
            const gps = parseTiff(view, offset + 10);
            if (gps) return gps;
          }
        }

        offset += 2 + segmentLength;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  function bufferFromBlob(blob) {
    if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
  }

  async function readGpsFromFile(file) {
    if (!file || typeof file.slice !== "function") return null;
    try {
      const buffer = await bufferFromBlob(file.slice(0, MAX_HEADER_BYTES));
      return readGpsFromBuffer(buffer);
    } catch (error) {
      return null;
    }
  }

  window.MandirMargExif = { readGpsFromFile, readGpsFromBuffer };
})();
