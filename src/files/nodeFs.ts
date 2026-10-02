import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { FS, Hasher } from './fsAdapter';

export const nodeFs: FS = {
  read: (p) => new Uint8Array(fs.readFileSync(p)),
  write: (p, bytes) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
  },
  exists: (p) => fs.existsSync(p),
  remove: (p) => fs.rmSync(p, { recursive: true, force: true }),
  mkdirp: (d) => { fs.mkdirSync(d, { recursive: true }); },
  list: (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []),
  rename: (from, to) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  },
  size: (p) => fs.statSync(p).size,
  usableSpace: async () => {
    try {
      const s = fs.statfsSync(process.cwd());
      return Number(s.bavail) * Number(s.bsize); // bavail = المتاح لغير الجذر · كما على الجهاز
    } catch {
      return Number.MAX_SAFE_INTEGER; // نظام لا يبلّغ · لا نمنع عملية بسببه
    }
  },
};

export const nodeHasher: Hasher = async (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
