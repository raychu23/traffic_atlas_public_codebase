const fs = require('fs');

/**
 * Minimal .npy reader for C-contiguous float32/float64 2D arrays.
 */
function parseNpy(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Expected Buffer');
  }
  // Use latin1 so byte 0x93 is preserved (Node 'ascii' maps 0x80–0xff incorrectly).
  if (buffer.length < 10 || buffer.toString('latin1', 0, 6) !== '\x93NUMPY') {
    throw new Error('Invalid .npy file');
  }

  const major = buffer[6];
  let headerLen;
  let headerStart;
  if (major === 1) {
    headerLen = buffer.readUInt16LE(8);
    headerStart = 10;
  } else if (major === 2) {
    headerLen = buffer.readUInt32LE(8);
    headerStart = 12;
  } else {
    throw new Error(`Unsupported .npy version ${major}`);
  }

  const headerEnd = headerStart + headerLen;
  const header = buffer.toString('latin1', headerStart, headerEnd);
  const shapeMatch = header.match(/'shape'\s*:\s*\(([^)]*)\)/);
  if (!shapeMatch) {
    throw new Error('Could not parse shape from .npy header');
  }
  const shape = shapeMatch[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((n) => Number(n));
  if (shape.length !== 2) {
    throw new Error(`Expected 2D array, got shape (${shape.join(', ')})`);
  }

  const descrMatch = header.match(/'descr'\s*:\s*'([^']+)'/);
  const descr = descrMatch ? descrMatch[1] : '<f4';
  const dataOffset = headerEnd;
  const [rows, cols] = shape;
  const count = rows * cols;

  let flat;
  if (descr === '<f4' || descr === '|f4') {
    flat = new Float32Array(buffer.buffer, buffer.byteOffset + dataOffset, count);
  } else if (descr === '<f8' || descr === '|f8') {
    flat = new Float64Array(buffer.buffer, buffer.byteOffset + dataOffset, count);
  } else {
    throw new Error(`Unsupported dtype ${descr}`);
  }

  const data = [];
  for (let i = 0; i < rows; i += 1) {
    const row = [];
    const base = i * cols;
    for (let j = 0; j < cols; j += 1) {
      row.push(flat[base + j]);
    }
    data.push(row);
  }
  return { data, rows, cols };
}

function loadNpyFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  return parseNpy(buffer);
}

module.exports = { parseNpy, loadNpyFile };
