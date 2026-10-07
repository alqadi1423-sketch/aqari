/** نقل Storage في node للاختبارات · fetch حقيقي إلى المحاكي، والملفات من القرص */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { StorageIO } from '@/cloud/storage';
import { CancelledError } from '@/domain/progress';

export const nodeStorageIO: StorageIO = {
  fetch: (...a) => fetch(...a),
  async sendFile(url, path, method, headers, onBytes, signal) {
    if (signal?.cancelled) throw new CancelledError();
    const body = fs.readFileSync(path);
    const res = await fetch(url, { method, headers, body });
    onBytes?.(body.length, body.length);
    return { status: res.status, body: await res.text() };
  },
  async downloadFile(url, path, headers, onBytes, signal) {
    if (signal?.cancelled) throw new CancelledError();
    const res = await fetch(url, { headers });
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      fs.writeFileSync(path, bytes);
      onBytes?.(bytes.length, bytes.length);
    }
    return { status: res.status };
  },
  async md5OfFile(path) { return createHash('md5').update(fs.readFileSync(path)).digest('base64'); },
  sizeOf: (path) => fs.statSync(path).size,
};
