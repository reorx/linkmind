/**
 * Check if a URL is a Twitter/X tweet URL.
 */
export function isTwitterUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.hostname === 'twitter.com' ||
        u.hostname === 'www.twitter.com' ||
        u.hostname === 'x.com' ||
        u.hostname === 'www.x.com') &&
      /\/status\/\d+/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Simple HTML to Markdown conversion (no external dependency).
 */
export function htmlToSimpleMarkdown(html: string): string {
  if (!html) return '';

  let md = html;

  // Handle headings
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');
  md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n');
  md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n');

  // Handle paragraphs and line breaks
  md = md.replace(/<p[^>]*>/gi, '\n\n');
  md = md.replace(/<\/p>/gi, '');
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // Handle bold and italic
  md = md.replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, '**$2**');
  md = md.replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, '*$2*');

  // Handle links
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');

  // Handle code
  md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
  md = md.replace(/<pre[^>]*>(.*?)<\/pre>/gis, '\n```\n$1\n```\n');

  // Handle lists
  md = md.replace(/<li[^>]*>/gi, '- ');
  md = md.replace(/<\/li>/gi, '\n');
  md = md.replace(/<\/?[uo]l[^>]*>/gi, '\n');

  // Handle blockquote
  md = md.replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gis, (_, content) => {
    return content
      .split('\n')
      .map((line: string) => `> ${line}`)
      .join('\n');
  });

  // Handle images
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)');
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, '![]($1)');

  // Strip remaining HTML tags
  md = md.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/&nbsp;/g, ' ');

  // Clean up excessive whitespace
  md = md.replace(/\n{3,}/g, '\n\n');
  md = md.trim();

  return md;
}
