import type { StorageBackend } from './types.js';
import { S3Storage } from './s3.js';
import { LocalStorage } from './local.js';

export type { StorageBackend } from './types.js';

let instance: StorageBackend | null = null;

export function getStorage(): StorageBackend {
  if (instance) return instance;

  const backend = process.env.STORAGE_BACKEND ?? 'local';

  switch (backend) {
    case 'r2':
      instance = S3Storage.fromR2Env();
      break;
    case 'minio':
      instance = S3Storage.fromMinIOEnv();
      break;
    case 'local':
      instance = new LocalStorage();
      break;
    default:
      throw new Error(`Unknown storage backend: ${backend}`);
  }

  return instance;
}

/** Generate a storage key for a record file */
export function recordFileKey(recordId: number, index: number, source: string, ext: string): string {
  return `records/${recordId}/${index}_${source}.${ext}`;
}
