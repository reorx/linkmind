export type UrlType = 'twitter' | 'web';

/** Data provided by a probe device after scraping a URL. Field names match DB columns. */
export interface ScrapeData {
  title?: string;
  markdown: string;
  og_title?: string;
  og_description?: string;
  og_image?: string;
  og_site_name?: string;
  og_type?: string;
  raw_media?: Array<{ type: string; url: string }>;
}

/** SSE scrape_request event payload from server */
export interface ScrapeRequestEvent {
  event_id: string;
  url: string;
  url_type: UrlType;
  link_id: number;
  created_at: string;
}

/** Result payload sent back to server */
export interface ScrapeResultPayload {
  event_id: string;
  success: boolean;
  data?: ScrapeData;
  error?: string;
}
