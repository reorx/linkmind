/**
 * Download Telegram photos and store them via the storage backend.
 */

import { logger } from './logger.js';
import { getStorage, recordFileKey } from './storage/index.js';
import { insertRecordFile } from './db/record-files.js';

const log = logger.child({ module: 'telegram-photo' });

interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/**
 * Download the largest photo from a Telegram message and store it.
 *
 * @param botApi - grammY bot api (ctx.api)
 * @param photos - ctx.message.photo array
 * @param recordId - the record this photo belongs to
 * @param index - file index (0 for first photo)
 */
export async function downloadAndStorePhoto(
  botApi: { getFile: (fileId: string) => Promise<{ file_path?: string }> },
  botToken: string,
  photos: PhotoSize[],
  recordId: number,
  index: number = 0,
): Promise<number | null> {
  if (!photos.length) return null;

  // Pick the largest photo (last in the array)
  const largest = photos[photos.length - 1];

  try {
    const file = await botApi.getFile(largest.file_id);
    if (!file.file_path) {
      log.warn({ fileId: largest.file_id }, 'No file_path returned from Telegram');
      return null;
    }

    // Download the file
    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      log.error({ status: res.status, fileId: largest.file_id }, 'Failed to download photo from Telegram');
      return null;
    }

    const data = Buffer.from(await res.arrayBuffer());
    const ext = file.file_path.split('.').pop() || 'jpg';
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

    // Upload to storage
    const storage = getStorage();
    const storageKey = recordFileKey(recordId, index, 'telegram', ext);
    await storage.put(storageKey, data, mimeType);

    // Insert record_files row
    const fileRecordId = await insertRecordFile({
      record_id: recordId,
      source: 'telegram_photo',
      source_ref: largest.file_id,
      storage_provider: process.env.STORAGE_BACKEND ?? 'local',
      storage_key: storageKey,
      mime_type: mimeType,
      size_bytes: data.length,
      width: largest.width,
      height: largest.height,
    });

    log.info(
      { recordId, fileRecordId, storageKey, size: data.length, width: largest.width, height: largest.height },
      'Photo stored',
    );

    return fileRecordId;
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), recordId }, 'Failed to store photo');
    return null;
  }
}
