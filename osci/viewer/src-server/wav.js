// Serve a channel WAV with HTTP Range support (so the browser can seek), and read its header for
// the sample rate shown in /api/meta. The WAVs are small (a few MB) and already the extracted,
// DC-removed, peak-normalized audio, so we stream them through untouched.

import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { wavPath } from './recordings.js';

// Read sampleRate / channels / bits from a canonical RIFF/WAVE header. Returns null if unreadable.
export async function wavInfo(osciDir, basename, ch) {
  let fh;
  try {
    fh = await open(wavPath(osciDir, basename, ch), 'r');
    const { buffer } = await fh.read(Buffer.alloc(44), 0, 44, 0);
    if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') return null;
    return {
      channels: buffer.readUInt16LE(22),
      sampleRate: buffer.readUInt32LE(24),
      bitsPerSample: buffer.readUInt16LE(34),
    };
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

export async function serveWav(osciDir, basename, ch, req, res) {
  const path = wavPath(osciDir, basename, ch);
  let size;
  try {
    size = (await stat(path)).size;
  } catch {
    res.writeHead(404);
    res.end('wav not found');
    return;
  }

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    createReadStream(path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': size });
    createReadStream(path).pipe(res);
  }
}
