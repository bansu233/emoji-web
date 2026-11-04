'use strict';

const path = require('node:path');

function detectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;

  // PNG
  if (
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    buffer.toString('ascii', 12, 16) === 'IHDR'
  ) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width > 0 && height > 0) {
      return { mime: 'image/png', extension: '.png', width, height };
    }
  }

  // GIF
  const gifHeader = buffer.toString('ascii', 0, 6);
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    if (width > 0 && height > 0) {
      return { mime: 'image/gif', extension: '.gif', width, height };
    }
  }

  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    const sofMarkers = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
    ]);
    while (offset + 1 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      if (offset >= buffer.length) break;
      const marker = buffer[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) break;
      if (offset + 2 > buffer.length) break;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
      if (sofMarkers.has(marker) && offset + 7 <= buffer.length) {
        const height = buffer.readUInt16BE(offset + 3);
        const width = buffer.readUInt16BE(offset + 5);
        if (width > 0 && height > 0) {
          return { mime: 'image/jpeg', extension: '.jpg', width, height };
        }
        break;
      }
      offset += segmentLength;
    }
  }

  // WebP
  if (
    buffer.length >= 30 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const format = buffer.toString('ascii', 12, 16);

    if (format === 'VP8X' && buffer.length >= 30) {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      if (width > 0 && height > 0) {
        return { mime: 'image/webp', extension: '.webp', width, height };
      }
    }

    if (
      format === 'VP8 ' &&
      buffer.length >= 30 &&
      buffer[23] === 0x9d &&
      buffer[24] === 0x01 &&
      buffer[25] === 0x2a
    ) {
      const width = buffer.readUInt16LE(26) & 0x3fff;
      const height = buffer.readUInt16LE(28) & 0x3fff;
      if (width > 0 && height > 0) {
        return { mime: 'image/webp', extension: '.webp', width, height };
      }
    }

    if (format === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      if (width > 0 && height > 0) {
        return { mime: 'image/webp', extension: '.webp', width, height };
      }
    }
  }

  return null;
}

function truncateChars(value, max) {
  return Array.from(value).slice(0, max).join('');
}

function cleanText(value, max, fallback) {
  const text = String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateChars(text, max) || fallback;
}

function cleanOriginalName(value) {
  const base = path.basename(String(value || ''));
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return truncateChars(cleaned, 120) || 'emoji';
}

function titleFromFilename(filename) {
  const withoutExtension = filename.replace(/\.[^.]+$/, '');
  return cleanText(withoutExtension.replace(/[_-]+/g, ' '), 60, '未命名表情');
}

module.exports = {
  detectImage,
  cleanText,
  cleanOriginalName,
  titleFromFilename,
};
