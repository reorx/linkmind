/**
 * Media handler: Download media (Twitter images, OG images, etc.),
 * upload to object storage, and insert record_files rows.
 *
 * Replaces the old image-handler.ts which stored files locally.
 */

import { logger } from './logger.js';
import { getStorage, recordFileKey } from './storage/index.js';
import { insertRecordFile } from './db/record-files.js';

const log = logger.child({ module: 'media-handler' });

export interface TwitterMedia {
  type: string;
  url: string;
}

export interface MediaResult {
  storage_key: string;
  original_url: string;
  width: number;
  height: number;
  size_bytes: number;
  file_record_id: number;
}

/**
 * Process Twitter media: download photos, upload to storage, insert record_files.
 * Returns results + any OCR texts extracted.
 */
export async function processTwitterMedia(
  recordId: number,
  media: TwitterMedia[],
): Promise<{ results: MediaResult[]; ocrTexts: string[] }> {
  const photos = media.filter((m) => m.type === 'photo' && m.url);
  if (photos.length === 0) return { results: [], ocrTexts: [] };

  const storage = getStorage();
  const results: MediaResult[] = [];

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    try {
      // Upgrade Twitter image URL to original quality
      const fullUrl = photo.url.includes('pbs.twimg.com')
        ? photo.url.replace(/\?.*$/, '') + '?format=jpg&name=large'
        : photo.url;

      const res = await fetch(fullUrl);
      if (!res.ok) {
        log.warn({ url: photo.url, status: res.status }, 'Failed to download Twitter image');
        continue;
      }

      const data = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') || 'image/jpeg';
      const ext = contentType.includes('png') ? 'png' : 'jpg';

      // Upload to storage
      const storageKey = recordFileKey(recordId, i, 'twitter', ext);
      await storage.put(storageKey, data, contentType);

      // Try to get dimensions from content-type or response headers
      // (sips is macOS-only; in production we skip dimensions)
      const { width, height } = await tryGetDimensions(data);

      // Insert record_files row
      const fileRecordId = await insertRecordFile({
        record_id: recordId,
        source: 'twitter_media',
        source_ref: photo.url,
        storage_provider: process.env.STORAGE_BACKEND ?? 'local',
        storage_key: storageKey,
        mime_type: contentType,
        size_bytes: data.length,
        width,
        height,
      });

      results.push({
        storage_key: storageKey,
        original_url: photo.url,
        width,
        height,
        size_bytes: data.length,
        file_record_id: fileRecordId,
      });

      log.info({ recordId, fileRecordId, storageKey, size: data.length }, 'Twitter image stored');
    } catch (err) {
      log.warn(
        { recordId, url: photo.url, err: err instanceof Error ? err.message : String(err) },
        'Failed to process Twitter image',
      );
    }
  }

  // OCR is skipped for now (old OCR binary was macOS-only, not available in Docker)
  // TODO: Add cloud-based OCR if needed
  return { results, ocrTexts: [] };
}

/**
 * Try to extract image dimensions from raw bytes (PNG/JPEG header parsing).
 * Returns 0,0 if unable to determine.
 */
async function tryGetDimensions(data: Buffer): Promise<{ width: number; height: number }> {
  try {
    // PNG: width at bytes 16-19, height at bytes 20-23
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
      const width = data.readUInt32BE(16);
      const height = data.readUInt32BE(20);
      return { width, height };
    }

    // JPEG: scan for SOF0/SOF2 marker
    if (data[0] === 0xff && data[1] === 0xd8) {
      let offset = 2;
      while (offset < data.length - 8) {
        if (data[offset] !== 0xff) break;
        const marker = data[offset + 1];
        // SOF0 (0xC0) or SOF2 (0xC2)
        if (marker === 0xc0 || marker === 0xc2) {
          const height = data.readUInt16BE(offset + 5);
          const width = data.readUInt16BE(offset + 7);
          return { width, height };
        }
        // Skip to next marker
        const segLen = data.readUInt16BE(offset + 2);
        offset += 2 + segLen;
      }
    }
  } catch {
    // Ignore parsing errors
  }
  return { width: 0, height: 0 };
}
