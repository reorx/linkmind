import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { logger } from '../logger.js';
import type { StorageBackend } from './types.js';

const log = logger.child({ module: 'storage:s3' });

interface S3StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
  /** Use path-style URLs (required for MinIO) */
  forcePathStyle?: boolean;
}

export class S3Storage implements StorageBackend {
  private client: S3Client;
  private bucket: string;
  private publicUrl: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.publicUrl = config.publicUrl.replace(/\/+$/, '');
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle ?? false,
    });

    log.info({ bucket: config.bucket, endpoint: config.endpoint }, 'S3 storage initialized');
  }

  /** Create from R2 env vars */
  static fromR2Env(): S3Storage {
    const accountId = requireEnv('R2_ACCOUNT_ID');
    const accessKeyId = requireEnv('R2_ACCESS_KEY_ID');
    const secretAccessKey = requireEnv('R2_SECRET_ACCESS_KEY');
    const bucket = requireEnv('R2_BUCKET_NAME');
    const publicUrl = requireEnv('R2_PUBLIC_URL');

    return new S3Storage({
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      region: 'auto',
      accessKeyId,
      secretAccessKey,
      bucket,
      publicUrl,
    });
  }

  /** Create from MinIO env vars */
  static fromMinIOEnv(): S3Storage {
    const endpoint = process.env.MINIO_ENDPOINT ?? 'http://127.0.0.1:9000';
    const accessKeyId = process.env.MINIO_ACCESS_KEY ?? 'minioadmin';
    const secretAccessKey = process.env.MINIO_SECRET_KEY ?? 'minioadmin';
    const bucket = process.env.MINIO_BUCKET ?? 'linkmind-files';
    const publicUrl = process.env.MINIO_PUBLIC_URL ?? `${endpoint}/${bucket}`;

    return new S3Storage({
      endpoint,
      region: 'us-east-1',
      accessKeyId,
      secretAccessKey,
      bucket,
      publicUrl,
      forcePathStyle: true,
    });
  }

  async put(key: string, data: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
      }),
    );
    log.debug({ key, size: data.length }, 'uploaded');
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    log.debug({ key }, 'deleted');
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  getUrl(key: string): string {
    return `${this.publicUrl}/${key}`;
  }
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}
