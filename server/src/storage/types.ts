export interface StorageBackend {
  /** Upload a file */
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  /** Download a file by key */
  get(key: string): Promise<Buffer>;
  /** Delete a file by key */
  delete(key: string): Promise<void>;
  /** Check if a file exists */
  exists(key: string): Promise<boolean>;
  /** Generate a public URL for the file */
  getUrl(key: string): string;
}
