import { XMLParser, XMLValidator } from 'fast-xml-parser';

const ARXIV_API = 'https://export.arxiv.org/api/query';
const STATS_URLS = ['https://arxiv.org/stats/get_monthly_submissions', 'https://export.arxiv.org/stats/get_monthly_submissions'];
const STATS_SOURCE = 'https://arxiv.org/stats/monthly_submissions';
const ATOM = 'http://www.w3.org/2005/Atom';
const OPENSEARCH = 'http://a9.com/-/spec/opensearch/1.1/';
const ARTICLE_ID = /^(?:\d{4}\.\d{4,5}|[a-z][a-z.\-]*\/\d{7})(?:v[1-9]\d*)?$/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_SEARCH_RESULTS = 15;
const MAX_XML_BYTES = 64 * 1024;
const memoryCache = new Map();
const TOPICS = ['Artificial intelligence', 'Machine learning', 'Deep learning', 'Large language models',
  'Transformer architecture', 'Attention mechanisms', 'Diffusion models', 'Computer vision',
  'Natural language processing', 'Reinforcement learning', 'Neural networks', 'Graph neural networks',
  'Robotics', 'Quantum computing', 'Quantum mechanics', 'Quantum information', 'Astrophysics',
  'Cosmology', 'Black holes', 'General relativity', 'Condensed matter physics', 'High energy physics',
  'Particle physics', 'Statistical mechanics', 'Applied mathematics', 'Number theory', 'Graph theory',
  'Topology', 'Algebraic geometry', 'Optimization', 'Probability theory', 'Statistical inference',
  'Bayesian statistics', 'Computational biology', 'Bioinformatics', 'Complex systems'];

export class ResearchError extends Error {
  constructor(status, detail) { super(detail); this.status = status; this.detail = detail; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  } });
}

export function canonicalPdfURL(value) {
  const fail = () => { throw new ResearchError(422, 'Use an HTTPS PDF or abstract article link from arxiv.org.'); };
  if (typeof value !== 'string' || value.length > 500 || !/^https:\/\//i.test(value.trim()) || value.includes('\\')) return fail();
  let url;
  try { url = new URL(value.trim()); } catch { return fail(); }
  if (url.protocol !== 'https:' || !['arxiv.org', 'export.arxiv.org', 'www.arxiv.org'].includes(url.hostname) ||
      url.username || url.password || url.port || url.search || url.hash || /[%\\]/.test(url.pathname)) return fail();
  const match = /^\/(?:pdf|abs)\/(.+?)\/?$/.exec(url.pathname);
  const identifier = match?.[1].replace(/\.pdf$/, '');
  if (!identifier || !ARTICLE_ID.test(identifier)) return fail();
  return 'https://arxiv.org/pdf/' + identifier;
}

function depsFor(env, deps) {
  return { fetchImpl: deps.fetchImpl || fetch, now: deps.now || (() => Date.now()),
    sleep: deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))),
    store: deps.store, cache: deps.cache || memoryCache, db: env?.DB };
}

async function readCache(key, deps) {
  const now = deps.now();
  const memory = deps.cache.get(key);
  if (memory && memory.expires > now) return memory.payload;
  deps.cache.delete(key);
  if (!deps.db?.prepare) return null;
  try {
    const row = await deps.db.prepare('SELECT payload, expires FROM edge_cache WHERE key = ? AND expires > ?').bind(key, now).first();
    if (!row || typeof row.payload !== 'string' || row.payload.length > 512 * 1024 || row.expires <= now) return null;
    const payload = JSON.parse(row.payload);
    remember(key, payload, row.expires, deps);
    return payload;
  } catch { return null; }
}

function remember(key, payload, expires, deps) {
  if (deps.cache.size >= 64 && !deps.cache.has(key)) deps.cache.delete(deps.cache.keys().next().value);
  deps.cache.set(key, { payload, expires });
}

async function writeCache(key, payload, ttl, deps) {
  const expires = deps.now() + ttl;
  remember(key, payload, expires, deps);
  if (!deps.db?.prepare) return;
  try {
    await deps.db.prepare('INSERT INTO edge_cache (key, payload, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, expires = excluded.expires')
      .bind(key, JSON.stringify(payload), expires).run();
  } catch { /* Public caching is optional; never turn a successful upstream result into an error. */ }
}

async function boundedText(response, maximum) {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maximum) {
    await response.body?.cancel();
    throw new ResearchError(502, 'arXiv returned too much data. Try a smaller search.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new ResearchError(502, 'arXiv returned too much data. Try a smaller search.');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

async function fetchText(url, deps, { maximum = 256 * 1024, timeout = 25000, permitRedirects = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let target = new URL(url);
    for (let step = 0; step < 4; step++) {
      const response = await deps.fetchImpl(target.href, { redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'application/atom+xml, text/csv, application/xml;q=0.9, */*;q=0.5',
          'User-Agent': 'EasyArXiv/1.0 (personal academic reading application)' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!permitRedirects || !location) throw new ResearchError(502, 'arXiv returned an invalid redirect. Please try again later.');
        const next = new URL(location, target);
        if (next.protocol !== 'https:' || next.username || next.password || next.port ||
            !['arxiv.org', 'export.arxiv.org', 'www.arxiv.org'].includes(next.hostname)) {
          throw new ResearchError(502, 'arXiv returned an invalid redirect. Please try again later.');
        }
        target = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if ([429, 503].includes(response.status)) throw new ResearchError(503, 'arXiv is busy. Please try your search again in a moment.');
        throw new ResearchError(502, 'arXiv could not complete this request. Please try again later.');
      }
      return await boundedText(response, maximum);
    }
    throw new ResearchError(502, 'arXiv returned too many redirects. Please try again later.');
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    if (controller.signal.aborted) throw new ResearchError(504, 'arXiv took too long to respond. Please try again.');
    throw new ResearchError(502, 'The arXiv service could not be reached. Please try again later.');
  } finally { clearTimeout(timer); }
}

function namespaces(object, parent = {}) {
  const result = { ...parent };
  for (const [key, value] of Object.entries(object || {})) {
    if (key === '@_xmlns') result[''] = value;
    else if (key.startsWith('@_xmlns:')) result[key.slice(8)] = value;
  }
  return result;
}

function qualified(key, local, uri, ns) {
  const split = key.indexOf(':');
  return (split === -1 ? key : key.slice(split + 1)) === local && ns[split === -1 ? '' : key.slice(0, split)] === uri;
}

function child(object, local, uri, ns) {
  const name = Object.keys(object || {}).find(key => !key.startsWith('@_') && qualified(key, local, uri, ns));
  return name === undefined ? undefined : object[name];
}
function list(value) { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function text(value) { return typeof value === 'object' && value ? String(value['#text'] || '') : String(value ?? ''); }
function clean(value) { return text(value).replace(/\s+/g, ' ').trim(); }

export function parseFeed(xml, start = 0) {
  if (typeof xml !== 'string' || xml.length > MAX_XML_BYTES ||
      (/[^\x00-\x7f]/.test(xml) && new TextEncoder().encode(xml).byteLength > MAX_XML_BYTES) ||
      /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) ||
      XMLValidator.validate(xml) !== true) {
    throw new ResearchError(502, 'arXiv returned an unreadable search response. Please try again.');
  }
  let document;
  try {
    document = new XMLParser({ ignoreAttributes: false, ignoreDeclaration: true, parseTagValue: false,
      parseAttributeValue: false, trimValues: false, processEntities: true }).parse(xml);
  } catch { throw new ResearchError(502, 'arXiv returned an unreadable search response. Please try again.'); }
  const keys = Object.keys(document).filter(key => !key.startsWith('?') && !key.startsWith('#'));
  if (keys.length !== 1) throw new ResearchError(502, 'arXiv returned an unexpected search response. Please try again.');
  const rootKey = keys[0], root = document[rootKey], ns = namespaces(root);
  if (!root || typeof root !== 'object' || !qualified(rootKey, 'feed', ATOM, ns)) {
    throw new ResearchError(502, 'arXiv returned an unexpected search response. Please try again.');
  }
  const entries = list(child(root, 'entry', ATOM, ns));
  if (entries.length > MAX_SEARCH_RESULTS) {
    throw new ResearchError(502, 'arXiv returned too many results. Try a smaller search.');
  }
  const papers = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const localNS = namespaces(entry, ns);
    const identifier = clean(child(entry, 'id', ATOM, localNS));
    if (identifier.includes('/api/errors')) throw new ResearchError(502, 'arXiv could not process this search. Try a shorter topic.');
    const links = list(child(entry, 'link', ATOM, localNS));
    const pdfLink = links.find(link => link && link['@_title'] === 'pdf')?.['@_href'];
    if (typeof pdfLink !== 'string') continue;
    let pdf;
    try { pdf = canonicalPdfURL(pdfLink.replace(/^http:\/\//, 'https://')); } catch { continue; }
    const title = clean(child(entry, 'title', ATOM, localNS));
    const summary = clean(child(entry, 'summary', ATOM, localNS));
    if (!title) continue;
    papers.push({ id: pdf.slice('https://arxiv.org/pdf/'.length), title: title.slice(0, 1000), summary: summary.slice(0, 40000),
      authors: list(child(entry, 'author', ATOM, localNS)).slice(0, 100).map(author =>
        clean(child(author, 'name', ATOM, namespaces(author, localNS))).slice(0, 200)),
      published: clean(child(entry, 'published', ATOM, localNS)) || null,
      updated: clean(child(entry, 'updated', ATOM, localNS)) || null,
      link: pdf.replace('/pdf/', '/abs/'), pdf_url: pdf,
      categories: list(child(entry, 'category', ATOM, localNS)).map(category => category?.['@_term']).filter(value => typeof value === 'string').slice(0, 30),
      reading_time: `${Math.max(1, Math.ceil(summary.split(/\s+/).filter(Boolean).length / 200))} min abstract`,
    });
  }
  const totalRaw = clean(child(root, 'totalResults', OPENSEARCH, ns));
  const total = /^\d+$/.test(totalRaw) && Number.isSafeInteger(Number(totalRaw)) ? Number(totalRaw) : papers.length;
  return { papers, total, returned: papers.length, start, has_more: papers.length > 0 && start + papers.length < total, source: 'arXiv API' };
}

function dateValue(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ResearchError(422, 'Use valid dates in YYYY-MM-DD format.');
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new ResearchError(422, 'Use valid dates in YYYY-MM-DD format.');
  return value;
}
function integer(value, fallback, lower, upper) {
  if (value === null || value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < lower || Number(value) > upper) {
    throw new ResearchError(422, 'Choose a valid page size and starting position.');
  }
  return Number(value);
}

export function searchParams(query, sortBy = 'relevance', sortOrder = 'descending', dateFrom = null, dateTo = null, start = 0, maximum = 15) {
  if (typeof query !== 'string' || query.length > 300) throw new ResearchError(422, 'Enter a title, author, research topic, or arXiv link.');
  const topic = query.replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
  if (!topic) throw new ResearchError(422, 'Enter a title, author, research topic, or arXiv link.');
  const sorts = { relevance: 'relevance', submittedDate: 'submittedDate', lastUpdatedDate: 'lastUpdatedDate',
    newest: 'submittedDate', oldest: 'submittedDate', 'date-desc': 'submittedDate', 'date-asc': 'submittedDate' };
  if (!Object.hasOwn(sorts, sortBy) || !['descending', 'ascending'].includes(sortOrder)) throw new ResearchError(422, 'Choose a valid sort field and ascending or descending order.');
  const lower = dateValue(dateFrom), upper = dateValue(dateTo);
  if (lower && upper && lower > upper) throw new ResearchError(422, 'The end date must be on or after the start date.');
  const params = { sortBy: sorts[sortBy], sortOrder: ['oldest', 'date-asc'].includes(sortBy) ? 'ascending' : sortOrder, start, max_results: maximum };
  if (/^https?:\/\//.test(topic)) params.id_list = canonicalPdfURL(topic).slice('https://arxiv.org/pdf/'.length);
  else if (ARTICLE_ID.test(topic)) params.id_list = topic;
  else {
    params.search_query = `all:"${topic}"`;
    if (lower || upper) params.search_query += ` AND submittedDate:[${lower ? lower.replaceAll('-', '') + '0000' : '*'} TO ${upper ? upper.replaceAll('-', '') + '2359' : '*'}]`;
  }
  return params;
}

export async function queryArxiv(params, env = {}, suppliedDeps = {}) {
  if (!Number.isInteger(params?.max_results) || params.max_results < 1 || params.max_results > MAX_SEARCH_RESULTS) {
    throw new ResearchError(422, 'Choose a page size between 1 and 15 papers.');
  }
  const deps = depsFor(env, suppliedDeps);
  const key = 'arxiv:' + JSON.stringify(Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))));
  const hit = await readCache(key, deps);
  if (hit && Array.isArray(hit.papers) && hit.papers.length <= MAX_SEARCH_RESULTS) return hit;
  if (typeof deps.store?.acquireArxivSlot !== 'function') throw new ResearchError(503, 'Search is temporarily unavailable. Please try again shortly.');
  const waitMs = await deps.store.acquireArxivSlot(deps.now());
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 15000) throw new ResearchError(503, 'Search is busy. Please try again shortly.');
  if (waitMs > 0) await deps.sleep(waitMs);
  const url = new URL(ARXIV_API);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const xml = await fetchText(url, deps, { maximum: MAX_XML_BYTES });
  const result = parseFeed(xml, params.start || 0);
  await writeCache(key, result, 300000, deps);
  return result;
}

// arXiv's statistics CSV contains simple two-column records, with occasional extra columns.
// Quoted commas and escaped quotes are handled without accepting unbounded CSV fields.
function csvRows(content) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (character === '"') {
      if (quoted && content[index + 1] === '"') { field += '"'; index++; }
      else if (!quoted && field.length) throw new Error('Malformed CSV');
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { row.push(field); field = ''; }
    else if (character === '\n' && !quoted) { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += character;
    if (field.length > 10000 || row.length > 30 || rows.length > 2000) throw new Error('Unexpected CSV');
  }
  if (quoted) throw new Error('Malformed CSV');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

export function parseMonthlyStats(content, now = new Date()) {
  if (typeof content !== 'string' || content.length > 256 * 1024) throw new Error('Unexpected CSV');
  const rows = csvRows(content.replace(/^\uFEFF/, ''));
  const header = rows.shift()?.map(value => value.trim());
  const monthIndex = header?.indexOf('month'), valueIndex = header?.indexOf('submissions');
  if (monthIndex === undefined || monthIndex < 0 || valueIndex < 0) throw new Error('Unexpected statistics columns');
  const currentMonth = now.toISOString().slice(0, 7), records = new Map();
  for (const row of rows) {
    const period = (row[monthIndex] || '').trim(), rawValue = (row[valueIndex] || '').trim();
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(period) || period >= currentMonth || !/^\d+$/.test(rawValue)) continue;
    const value = Number(rawValue);
    if (!Number.isSafeInteger(value)) continue;
    records.set(period, { label: MONTHS[Number(period.slice(-2)) - 1], value, period });
  }
  const months = [...records.keys()].sort().slice(-9).map(period => records.get(period));
  if (months.length < 2) throw new Error('Not enough statistics records');
  return months;
}

async function monthlyStats(env, deps) {
  const cached = await readCache('stats:monthly', deps);
  if (cached && deps.now() - cached.fetched < 21600000) return cached.data;
  // Persist the failure backoff too, so different isolates do not retry an outage on every page view.
  const backoff = await readCache('stats:backoff', deps);
  if (!backoff) {
    for (const dataset_url of STATS_URLS) {
      try {
        const csv = await fetchText(dataset_url, deps, { timeout: 8000 });
        const months = parseMonthlyStats(csv, new Date(deps.now()));
        const first = months[0], last = months.at(-1);
        const period_label = first.period.slice(0, 4) === last.period.slice(0, 4) ?
          `${first.label}–${last.label} ${last.period.slice(0, 4)}` : `${first.label} ${first.period.slice(0, 4)}–${last.label} ${last.period.slice(0, 4)}`;
        const data = { months, source_url: STATS_SOURCE, dataset_url, updated_at: new Date(deps.now()).toISOString(),
          period_label, stale: false, completed_months_only: true };
        await writeCache('stats:monthly', { fetched: deps.now(), data }, 7 * 86400000, deps);
        return data;
      } catch { /* One official mirror is tried before returning an honest outage state. */ }
    }
    await writeCache('stats:backoff', { failed: true }, 300000, deps);
  }
  if (cached && deps.now() - cached.fetched < 7 * 86400000) return { ...cached.data, stale: true };
  throw new ResearchError(503, 'arXiv statistics are temporarily unavailable. Please try again later.');
}

async function suggestions(phrase, deps) {
  if (phrase.length > 160) throw new ResearchError(422, 'Use a shorter research topic.');
  phrase = phrase.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!phrase) return { suggestions: [] };
  const words = phrase.split(' ');
  const matches = TOPICS.filter(topic => words.every(word => topic.toLowerCase().includes(word)));
  matches.sort((a, b) => Number(!a.toLowerCase().startsWith(phrase)) - Number(!b.toLowerCase().startsWith(phrase)) || a.toLowerCase().localeCompare(b.toLowerCase()));
  const result = matches.slice(0, 5).map(topic => ({ type: 'topic', label: topic, value: topic }));
  const caches = [...deps.cache].filter(([key, entry]) => key.startsWith('arxiv:') && entry.expires > deps.now()).reverse().slice(0, 8).map(([, entry]) => entry.payload);
  if (deps.db?.prepare) {
    try {
      // Autocomplete runs on each paused keystroke. Only inspect a few small
      // cached responses so it stays within the free Worker's CPU budget.
      const rows = await deps.db.prepare("SELECT payload FROM edge_cache WHERE key LIKE 'arxiv:%' AND expires > ? AND length(payload) <= 65536 ORDER BY expires DESC LIMIT 3").bind(deps.now()).all();
      let bytes = 0;
      for (const row of rows.results || []) {
        if (typeof row.payload !== 'string' || row.payload.length > 65536 || bytes + row.payload.length > 131072) continue;
        bytes += row.payload.length;
        caches.push(JSON.parse(row.payload));
      }
    } catch { /* Topic suggestions continue to work without the optional public result cache. */ }
  }
  const known = new Set();
  for (const cache of caches) for (const paper of (cache?.papers || []).slice(0, 50)) {
    const id = typeof paper.id === 'string' ? paper.id.replace(/v\d+$/, '') : '';
    const title = typeof paper.title === 'string' ? paper.title : '';
    if (!id || known.has(id) || !title || !words.every(word => title.toLowerCase().includes(word) || id.toLowerCase().includes(word))) continue;
    known.add(id);
    result.push({ type: 'paper', label: title, value: id, id, authors: Array.isArray(paper.authors) ? paper.authors : [] });
    if (result.length >= 8) return { suggestions: result };
  }
  return { suggestions: result };
}

export async function handleResearch(request, env = {}, suppliedDeps = {}) {
  const url = new URL(request.url), path = url.pathname, values = url.searchParams;
  if (!['/api/stats', '/api/search_papers', '/api/search', '/api/paper', '/api/suggestions', '/api/recent_papers'].includes(path)) return null;
  if (request.method !== 'GET') return json({ detail: 'Method not allowed.' }, 405);
  const deps = depsFor(env, suppliedDeps);
  try {
    if (path === '/api/stats') return json(await monthlyStats(env, deps));
    if (path === '/api/suggestions') return json(await suggestions(values.get('query') || '', deps));
    if (path === '/api/paper') {
      const pdf = canonicalPdfURL(values.get('pdf'));
      const result = await queryArxiv({ id_list: pdf.slice('https://arxiv.org/pdf/'.length), start: 0, max_results: 1 }, env, deps);
      if (!result.papers.length) throw new ResearchError(404, 'This arXiv paper could not be found.');
      return json(result.papers[0]);
    }
    const recent = path === '/api/recent_papers';
    const start = integer(values.get('start'), 0, 0, 10000), maximum = integer(values.get('max_results'), 15, 1, MAX_SEARCH_RESULTS);
    const from = values.get('dateFrom') || values.get('date_from'), to = values.get('dateTo') || values.get('date_to');
    const params = searchParams(recent ? 'browse' : values.get('query'), values.get('sortBy') || values.get('sort_by') || (recent ? 'submittedDate' : 'relevance'),
      values.get('sort_order') || 'descending', from, to, start, maximum);
    if (recent) {
      const lower = dateValue(from) || '1991-07-01', upper = dateValue(to) || new Date(deps.now()).toISOString().slice(0, 10);
      if (lower > upper) throw new ResearchError(422, 'The end date must be on or after the start date.');
      params.search_query = `submittedDate:[${lower.replaceAll('-', '')}0000 TO ${upper.replaceAll('-', '')}2359]`;
    }
    return json(await queryArxiv(params, env, deps));
  } catch (error) {
    if (error instanceof ResearchError) return json({ detail: error.detail }, error.status);
    return json({ detail: 'The research service is temporarily unavailable. Please try again shortly.' }, 503);
  }
}
