// Recognition is intentionally restricted to Eq. 1 in Attention Is All You Need.
// This is a signature check for a local worked example, not a formula parser.
const MAX_SELECTION_LENGTH = 2000;

export function normalizeSelection(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_SELECTION_LENGTH) return '';
  return text.normalize('NFKC')
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[⎷]/g, '√')
    .replace(/K⊤/gi, 'KT')
    .replace(/K\^\{?T\}?/gi, 'KT')
    .replace(/d_\{?k\}?/gi, 'dk')
    .toLowerCase();
}

export function classifySelection(text, paperId) {
  if (typeof paperId !== 'string' || !/^1706\.03762(?:v[1-9]\d*)?$/.test(paperId)) return null;
  const normalized = normalizeSelection(text);
  // PDF text order omits a drawn fraction bar, so both QKT/√dk and QKT√dk
  // represent the same printed fraction. Every operand and the square root
  // must be present; a word such as "softmax" alone never opens an experiment.
  if (!/^attention\(q,k,v\)=softmax\(qkt\/?(?:√dk|sqrt\(dk\))\)v(?:\(1\))?$/.test(normalized)) return null;
  return {formula: 'scaled-attention', paperId: '1706.03762', normalized};
}

export function arxivPDFSource(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\u0000-\u0020\u007f?\\]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'arxiv.org' || url.username ||
        url.password || url.port || url.search) return null;
    const path = /^\/pdf\/((?:\d{4}\.\d{4,5}|[a-z]+(?:[-.][a-zA-Z]+)*\/\d{7})(?:v[1-9]\d*)?)(?:\.pdf)?$/.exec(url.pathname);
    if (!path) return null;
    return {paperId: path[1].replace(/v\d+$/, ''), versionedId: path[1], originalUrl: raw};
  } catch { return null; }
}

export function isLocalPreview(href) {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
      url.pathname.endsWith('/sidepanel.html') && url.searchParams.get('preview') === '1';
  } catch { return false; }
}
