import fs from 'fs/promises';
import path from 'path';
import { logger } from '../logger.js';
import type { StorageBackend } from './types.js';

const log = logger.child({ module: 'storage:local' });

export class LocalStorage implements StorageBackend {
  private baseDir: string;

  constructor() {
    this.baseDir = process.env.STORAGE_LOCAL_DIR ?? './data/files';
    log.info({ baseDir: this.baseDir }, 'local storage initialized');
  }

  private filePath(key: string): string {
    return path.join(this.baseDir, key);
  }

  async put(key: string, data: Buffer, _contentType?: string): Promise<void> {
    const fp = this.filePath(key);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, data);
    log.debug({ key, size: data.length }, 'written');
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.filePath(key));
  }

  async delete(key: string): Promise<void> {
    await fs.unlink(this.filePath(key));
    log.debug({ key }, 'deleted');
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.filePath(key));
      return true;
    } catch {
      return false;
    }
  }

  getUrl(key: string): string {
    // For local dev, return a relative path that the web server can serve
    return `/files/${key}`;
  }
}
