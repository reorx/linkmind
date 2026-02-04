/**
 * Image handler: Download Twitter images, create thumbnails, extract OCR text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Path to compiled OCR binary
const OCR_BINARY = path.resolve(import.meta.dirname, '../scripts/ocr');

// Base directory for storing images
const IMAGES_DIR = path.resolve(import.meta.dirname, '../data/images');

export interface ImageResult {
  original_url: string;
  local_path: string;
  thumbnail_path: string;
  ocr_text?: string;
  width: number;
  height: number;
}

export interface TwitterMedia {
  type: string;
  url: string;
}

/**
 * Process Twitter media: download images, create thumbnails, extract OCR text.
 */
export async function processTwitterImages(linkId: number, media: TwitterMedia[]): Promise<ImageResult[]> {
  // Filter to photos only
  const photos = media.filter((m) => m.type === 'photo' && m.url);
  if (photos.length === 0) return [];

  // Create directory for this link
  const linkDir = path.join(IMAGES_DIR, String(linkId));
  fs.mkdirSync(linkDir, { recursive: true });

  const results: ImageResult[] = [];

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const localPath = `${i}.jpg`;
    const thumbnailPath = `${i}_thumb.jpg`;
    const fullPath = path.join(linkDir, localPath);
    const thumbFullPath = path.join(linkDir, thumbnailPath);

    // Download image
    const downloaded = await downloadImage(photo.url, fullPath);
    if (!downloaded) continue;

    // Get image dimensions
    const dimensions = await getImageDimensions(fullPath);

    // Create thumbnail
    await createThumbnail(fullPath, thumbFullPath, 300);

    // Extract OCR text
    const ocrText = await extractText(fullPath);

    results.push({
      original_url: photo.url,
      local_path: localPath,
      thumbnail_path: thumbnailPath,
      ocr_text: ocrText || undefined,
      width: dimensions.width,
      height: dimensions.height,
    });
  }

  return results;
}

/**
 * Download an image from URL to local path.
 */
async function downloadImage(url: string, destPath: string): Promise<boolean> {
  // Upgrade Twitter image URL to original quality
  const fullUrl = url.includes('pbs.twimg.com') ? url.replace(/\?.*$/, '') + '?format=jpg&name=large' : url;

  const response = await fetch(fullUrl);
  if (!response.ok) {
    console.error(`Failed to download image: ${response.status} ${url}`);
    return false;
  }

  const buffer = await response.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buffer));
  return true;
}

/**
 * Get image dimensions using sips.
 */
async function getImageDimensions(imagePath: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', imagePath]);

  const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/);
  const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/);

  return {
    width: widthMatch ? parseInt(widthMatch[1], 10) : 0,
    height: heightMatch ? parseInt(heightMatch[1], 10) : 0,
  };
}

/**
 * Create a thumbnail using sips (macOS built-in).
 */
async function createThumbnail(srcPath: string, destPath: string, maxWidth: number = 300): Promise<void> {
  // Copy then resize
  fs.copyFileSync(srcPath, destPath);
  await execFileAsync('sips', [
    '--resampleWidth',
    String(maxWidth),
    '--setProperty',
    'formatOptions',
    '80', // JPEG quality
    destPath,
  ]);
}

/**
 * Extract text from image using macOS OCR (Vision framework).
 */
async function extractText(imagePath: string): Promise<string | null> {
  // Check if OCR binary exists
  if (!fs.existsSync(OCR_BINARY)) {
    console.warn('OCR binary not found, skipping text extraction');
    return null;
  }

  const { stdout, stderr } = await execFileAsync(OCR_BINARY, [imagePath], {
    timeout: 30000,
  });

  if (stderr) {
    console.error(`OCR warning: ${stderr}`);
  }

  const text = stdout.trim();
  return text || null;
}
