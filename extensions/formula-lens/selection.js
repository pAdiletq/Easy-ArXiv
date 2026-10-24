// A source/selection boundary only. Mathematical interpretation belongs to the
// local expression engine; the bridge never rewrites case, powers or spacing.
export const MAX_SELECTION_LENGTH = 2000;
const UNSAFE_URL_CHARACTERS = /[\u0000-\u0020\u007f-\u009f\u202a-\u202e\u2066-\u2069\\]/;
const ARXIV_PATH = /^\/pdf\/((?:\d{4}\.\d{4,5}|[a-z]+(?:[-.][a-zA-Z]+)*\/\d{7})(?:v[1-9]\d*)?)(?:\.pdf)?$/;

export function validSelection(text) {
  return typeof text === 'string' && text.length <= MAX_SELECTION_LENGTH && Boolean(text.trim());
}

export function pdfSource(rawURL) {
  if (typeof rawURL !== 'string' || rawURL.length > 8192 || UNSAFE_URL_CHARACTERS.test(rawURL)) return null;
  try {
    const url = new URL(rawURL);
    const authority = /^https:\/\/([^/?#]+)/i.exec(rawURL)?.[1];
    if (!authority || /[@%]/.test(authority) || url.protocol !== 'https:' || !url.hostname ||
        url.username || url.password || url.port) return null;
    if (url.hostname === 'arxiv.org') {
      const match = ARXIV_PATH.exec(url.pathname);
      if (!match) return null;
      const versionedId = match[1];
      return {originalUrl: rawURL, sourceId: 'arxiv:' + versionedId,
        label: 'arxiv.org · ' + versionedId, paperId: versionedId.replace(/v\d+$/, ''), versionedId};
    }
    if (!/\.pdf$/i.test(url.pathname)) return null;
    const filename = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/') + 1));
    if (!filename || UNSAFE_URL_CHARACTERS.test(filename.replace(/ /g, '')) || /[/\\]/.test(filename)) return null;
    // Query parameters may identify signed/private download links. They remain
    // only in the original link, never in the visible label or source identifier.
    return {originalUrl: rawURL, sourceId: 'pdf:' + url.origin + url.pathname,
      label: url.hostname + ' · ' + filename};
  } catch { return null; }
}

// Compatibility for callers that specifically need arXiv metadata.
export function arxivPDFSource(rawURL) {
  const source = pdfSource(rawURL);
  return source?.paperId ? source : null;
}

export function samePDFDocument(first, second) {
  if (!pdfSource(first) || !pdfSource(second)) return false;
  const left = new URL(first), right = new URL(second);
  left.hash = ''; right.hash = '';
  return left.href === right.href;
}

export function isLocalPreview(href) {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password &&
      url.pathname.endsWith('/sidepanel.html') && url.searchParams.get('preview') === '1';
  } catch { return false; }
}
