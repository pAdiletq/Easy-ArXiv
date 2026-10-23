import { listenToPaper, listenToText, stopSpeech, openAudioSettings } from './audio.js?v=github-2';
export { listenToPaper, listenToText, stopSpeech, openAudioSettings };
const SELECTED_KEY = 'easy-arxiv-web:selected:v1';
let memorySaved = [];
let memorySelected = null;

const paths = {
  search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/>',
  file: '<path d="M6 3h8l4 4v14H6Zm8 0v5h4M9 12h6m-6 4h6"/>',
  external: '<path d="M14 4h6v6m0-6L10 14M10 4H4v16h16v-6"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4Z"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  back: '<path d="M20 12H4m6-6-6 6 6 6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  volume: '<path d="M11 4 5 9H2v6h3l6 5Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  stop: '<path d="M6 6h12v12H6Z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  filter: '<path d="M3 6h18M3 12h18M3 18h18"/><path d="M8 3v6m8 0v6m-6 0v6"/>',
  spark: '<path d="m12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8ZM20 2v5m-2.5-2.5h5"/>',
  github: '<path d="M9 19c-4.5 1.3-4.5-2-6-2m12 4v-3.6c0-1 .1-1.5-.5-2 3.5-.4 6.5-1.6 6.5-6.5 0-1.4-.5-2.5-1.3-3.4.2-.5.5-2-.1-3.5 0 0-1.1-.4-3.6 1.3a12.4 12.4 0 0 0-6 0C7 1.6 6 2 6 2c-.6 1.5-.3 3-.1 3.5A5 5 0 0 0 4.5 9c0 5 3 6 6.5 6.5-.5.4-.7 1.1-.7 2V21"/>',
  linkedin: '<path d="M4 9v11M4 4v.5M10 20V9h4v2c2-3 6-2 6 2v7M10 9h4"/>',
  producthunt: '<circle cx="12" cy="12" r="10"/><path d="M9 18V6h4a4 4 0 0 1 0 8H9m0-4h4"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6"/>',
};

export function icon(name, className = '') {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
}
export function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
export function arxivId(value) {
  if (typeof value !== 'string') return '';
  let input = value.trim();
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (!['arxiv.org','export.arxiv.org','www.arxiv.org'].includes(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) return '';
      input = url.pathname.replace(/^\/(?:pdf|abs|html)\//, '');
    } catch { return ''; }
  }
  input = input.replace(/^arxiv:/i, '').replace(/\.pdf\/?$/i, '').replace(/\/$/, '');
  return /^(?:\d{4}\.\d{4,5}|[a-z][a-z.\-]*\/\d{7})(?:v[1-9]\d*)?$/i.test(input) ? input.replace(/v(\d+)$/i,'v$1') : '';
}
export function pdfUrl(value) {
  const id = arxivId(typeof value === 'object' ? (value?.pdf_url || value?.pdf || value?.id || '') : value);
  return id ? `https://arxiv.org/pdf/${id}` : '';
}
export function normalizePaper(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pdf = pdfUrl(raw.pdf_url || raw.pdf || raw.link || raw.id || '');
  if (!pdf) return null;
  const id = arxivId(pdf).replace(/v\d+$/, '');
  const authorList = Array.isArray(raw.authors) ? raw.authors : typeof raw.authors === 'string' ? raw.authors.split(',') : [];
  return {id, title: String(raw.title || 'Untitled paper').replace(/\s+/g,' ').trim().slice(0,1000),
    summary: String(raw.summary || raw.abstract || '').trim().slice(0,40000),
    authors: authorList.map(a => typeof a === 'string' ? a : a?.name || '').filter(Boolean).map(a => String(a).slice(0,200)),
    published: typeof raw.published === 'string' ? raw.published : '',
    pdf_url: pdf, link: `https://arxiv.org/abs/${arxivId(pdf)}`,
    category: String(raw.category || raw.categories?.[0] || 'arXiv').slice(0,80),
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map(String).slice(0,8) : [],
    source_label: String(raw.source_label || 'arXiv'),
    summary_label: String(raw.summary_label || 'Abstract')};
}
let currentUser = null;
let authVersion = 0;
const pendingSaves = new Map();
let configurationPromise = null;

function emit(name, detail) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name, {detail}));
}
function updateAuthVisibility() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('[data-auth-only]').forEach(element => { element.hidden = !currentUser; });
}
function authState() { return {authenticated: Boolean(currentUser), user: currentUser ? {...currentUser} : null}; }
function setGuest() {
  authVersion++; currentUser = null; memorySaved = []; updateAuthVisibility();
  emit('papers:auth', authState()); emit('papers:saved', {papers: []});
}
function normalizeSaved(records) {
  return Array.isArray(records) ? [...new Map(records.map(normalizePaper).filter(Boolean).map(paper => [paper.id,paper])).values()] : [];
}
async function fetchSaved(version) {
  const response = await fetch('/api/saved', {credentials:'same-origin', headers:{Accept:'application/json'}});
  if (version !== authVersion) return [];
  if (response.status === 401) { setGuest(); return []; }
  if (!response.ok) throw new Error('Saved papers unavailable');
  const payload = await response.json();
  if (version !== authVersion || !currentUser) return [];
  memorySaved = normalizeSaved(payload.papers);
  emit('papers:saved', {papers:loadSaved()});
  return loadSaved();
}
async function initializeAuth() {
  try {
    const response = await fetch('/api/session', {credentials:'same-origin', headers:{Accept:'application/json'}});
    const session = response.ok ? await response.json() : null;
    const user = session?.authenticated && session.user;
    if (user && typeof user.orcid === 'string' && /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(user.orcid)) {
      currentUser = {orcid:user.orcid, name:typeof user.name === 'string' ? user.name.slice(0,200) : 'Researcher'};
      try { await fetchSaved(authVersion); } catch { /* The account remains signed in if the saved-papers service is temporarily unavailable. */ }
    }
  } catch { currentUser = null; memorySaved = []; }
  updateAuthVisibility(); emit('papers:auth', authState());
  return authState();
}
export const authReady = typeof fetch === 'function' ? initializeAuth() : Promise.resolve(authState());
export function isAuthenticated() { return Boolean(currentUser); }
export function loadSaved() { return currentUser ? memorySaved.map(paper => ({...paper,authors:[...paper.authors],keywords:[...paper.keywords]})) : []; }
export function isSaved(paperOrId) {
  const raw = typeof paperOrId === 'string' ? paperOrId : paperOrId?.id;
  const id = arxivId(raw || '').replace(/v\d+$/, '');
  return loadSaved().some(paper => paper.id === id);
}
export async function refreshSaved() {
  await authReady;
  if (!currentUser) return [];
  try { return await fetchSaved(authVersion); }
  catch { toast('Your saved papers could not be loaded. Please try again.'); return loadSaved(); }
}
function getConfiguration() {
  if (!configurationPromise) configurationPromise = fetch('/api/config', {credentials:'same-origin'}).then(response => response.ok ? response.json() : {}).catch(() => ({}));
  return configurationPromise;
}
function ensureAccountStyles() {
  if (typeof document === 'undefined' || document.getElementById('accountAudioStyles')) return;
  const link = document.createElement('link'); link.id='accountAudioStyles'; link.rel='stylesheet'; link.href='/static/css/account-audio.css';
  (document.head || document.body).append(link);
}
async function startSignIn() {
  const config = await getConfiguration();
  if (config.orcid_configured) window.location.assign('/auth/login');
  else toast('ORCID sign-in is not configured on this server yet. Search, reading and audio remain available.');
}
export async function requireSignIn(reason = 'Sign in to save papers to your personal library.') {
  await authReady;
  if (currentUser) return true;
  if (typeof document === 'undefined') return false;
  ensureAccountStyles();
  let dialog = document.getElementById('signInDialog');
  if (!dialog) {
    dialog=document.createElement('dialog'); dialog.id='signInDialog'; dialog.className='signin-dialog'; dialog.setAttribute('aria-labelledby','signInTitle');
    dialog.innerHTML=`<button class="signin-close" type="button" aria-label="Close sign-in dialog">${icon('close')}</button><span class="signin-orcid" aria-hidden="true">iD</span><p class="signin-eyebrow">YOUR RESEARCH, IN ONE PLACE</p><h2 id="signInTitle">Keep the papers<br>you want to return to.</h2><p id="signInReason"></p><button class="signin-primary" type="button"><span class="orcid-mark" aria-hidden="true">iD</span>Continue with ORCID ${icon('arrow')}</button><p class="signin-service-note" hidden>ORCID sign-in has not been configured on this server yet.</p><button class="signin-dismiss" type="button">Keep exploring</button>`;
    const close=()=>{ if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open'); };
    dialog.querySelector('.signin-close').addEventListener('click',close); dialog.querySelector('.signin-dismiss').addEventListener('click',close);
    dialog.querySelector('.signin-primary').addEventListener('click',async event=>{ const button=event.currentTarget;button.disabled=true;await startSignIn();button.disabled=false; });
    dialog.addEventListener('click',event=>{if(event.target===dialog)close();});
    document.body.append(dialog);
  }
  dialog.querySelector('#signInReason').textContent=reason;
  const config=await getConfiguration();
  dialog.querySelector('.signin-service-note').hidden=Boolean(config.orcid_configured);
  dialog.querySelector('.signin-primary').disabled=!config.orcid_configured;
  if (!dialog.open) { if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open',''); }
  return false;
}
export async function toggleSaved(raw) {
  const paper=normalizePaper(raw);
  if (!paper) return false;
  await authReady;
  if (!currentUser) { await requireSignIn(); return false; }
  if (pendingSaves.has(paper.id)) return pendingSaves.get(paper.id);
  const version=authVersion;
  const adding=!isSaved(paper.id);
  const mutation=(async()=>{
    try {
      const response=await fetch(adding?'/api/saved':'/api/saved/'+encodeURIComponent(paper.id), {
        method:adding?'POST':'DELETE', credentials:'same-origin', headers:{Accept:'application/json',...(adding?{'Content-Type':'application/json'}:{})},
        ...(adding?{body:JSON.stringify({paper})}:{})
      });
      if(version!==authVersion)return false;
      if(response.status===401){setGuest();await requireSignIn('Your session expired. Sign in again to save this paper.');return false;}
      if(!response.ok)throw new Error('Save failed');
      let payload=null;try{payload=await response.json();}catch{}
      if(version!==authVersion || !currentUser)return false;
      memorySaved=Array.isArray(payload?.papers)?normalizeSaved(payload.papers):adding?[paper,...memorySaved.filter(item=>item.id!==paper.id)]:memorySaved.filter(item=>item.id!==paper.id);
      emit('papers:saved',{paper,saved:adding,papers:loadSaved()});
      toast(adding?'Saved to your papers.':'Removed from saved papers.');
      return adding;
    } catch { toast(adding?'This paper could not be saved. Please try again.':'This paper could not be removed. Please try again.');return isSaved(paper.id); }
    finally {pendingSaves.delete(paper.id);}
  })();
  pendingSaves.set(paper.id,mutation);
  return mutation;
}
export function selectPaper(raw) {
  const paper = normalizePaper(raw); if (!paper) return;
  memorySelected = paper;
  try { sessionStorage.setItem(SELECTED_KEY,JSON.stringify(paper)); } catch {}
}
export function readSelectedPaper() {
  try { return normalizePaper(JSON.parse(sessionStorage.getItem(SELECTED_KEY) || 'null')) || memorySelected; } catch { return memorySelected; }
}
export function readUrl(paper) {
  return `/read?paper=${encodeURIComponent(arxivId(paper.pdf_url || paper.id) || paper.id)}`;
}
export function questUrl(paper) {
  const p = normalizePaper(paper);
  return p ? `/quest?pdf=${encodeURIComponent(p.pdf_url)}&title=${encodeURIComponent(p.title)}` : '/quest';
}
export function shortAuthors(paper, max = 3) {
  return paper.authors.slice(0,max).join(', ') + (paper.authors.length > max ? ' et al.' : '');
}
export function formatDate(value, options = {}) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC',...options}).format(date);
}
export function toast(message) {
  if (typeof document === 'undefined') return;
  let el = document.getElementById('siteToast');
  if (!el) { el = document.createElement('div'); el.id='siteToast'; el.className='toast'; el.setAttribute('role','status'); document.body.append(el); }
  el.textContent=message; el.hidden=false; clearTimeout(toast.timer);
  toast.timer=setTimeout(() => { el.hidden=true; },4200);
}
export async function mountShell({footer=true} = {}) {
  ensureAccountStyles();
  const header=document.querySelector('[data-site-header]');
  if(header)header.innerHTML=`<header class="site-header"><div class="container header-inner"><a class="site-brand" href="/" aria-label="Easy ArXiv home">Easy ArXiv<small>Research Made Easy</small></a><div class="account-control"><button class="orcid-button" type="button" data-orcid><span class="orcid-mark" aria-hidden="true">iD</span><span class="account-button-copy"><span data-account-label>Continue with ORCID</span><small data-account-caption>For your research library</small></span><span data-account-chevron aria-hidden="true">${icon('arrow')}</span></button><div class="account-menu" id="accountMenu" hidden><div class="account-identity"><span class="orcid-mark" aria-hidden="true">iD</span><div><p data-account-name></p><small data-account-id></small></div></div><a href="/saved">Saved papers ${icon('bookmark')}</a><button type="button" data-audio-settings>Voice preferences ${icon('volume')}</button><a data-orcid-record target="_blank" rel="noopener noreferrer">ORCID record ${icon('external')}</a><button class="account-signout" type="button" data-signout>Sign out ${icon('arrow')}</button></div></div></div></header>`;
  const footerEl=document.querySelector('[data-site-footer]');
  if(footer && footerEl)footerEl.innerHTML=`<footer class="site-footer"><p>© ${new Date().getFullYear()} Easy ArXiv. All rights reserved.</p><p class="footer-tagline">Making research accessible to everyone</p><p class="footer-attribution">Thank you to <a href="https://arxiv.org/" target="_blank" rel="noopener noreferrer">arXiv</a> for use of its open access interoperability. This service was not reviewed or approved by, nor does it necessarily express or reflect the policies or opinions of, arXiv.</p><div class="social-links"><a href="https://www.producthunt.com/products/easy-arxiv" target="_blank" rel="noopener noreferrer" aria-label="Easy ArXiv on Product Hunt">${icon('producthunt')}</a><a href="https://github.com/pAdiletq/Easy-ArXiv" target="_blank" rel="noopener noreferrer" aria-label="Easy ArXiv on GitHub">${icon('github')}</a><a href="https://www.linkedin.com/company/arxiv/" target="_blank" rel="noopener noreferrer" aria-label="arXiv on LinkedIn">${icon('linkedin')}</a></div></footer>`;
  const button=header?.querySelector('[data-orcid]');const menu=header?.querySelector('.account-menu');
  const closeAccount=(restoreFocus=false)=>{if(!menu || !button)return;menu.hidden=true;button.setAttribute('aria-expanded','false');if(restoreFocus)button.focus();};
  const renderAccount=()=>{
    if(!button || !menu)return;
    header.querySelector('[data-account-label]').textContent=currentUser?.name || (currentUser?'My ORCID':'Continue with ORCID');
    header.querySelector('[data-account-caption]').textContent=currentUser?'Your research library':'For your research library';
    button.classList.toggle('is-authenticated',Boolean(currentUser));
    header.querySelector('[data-account-chevron]').innerHTML=icon(currentUser?'chevron':'arrow');
    if(currentUser){
      button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls','accountMenu');
      header.querySelector('[data-account-name]').textContent=currentUser.name || 'Researcher';header.querySelector('[data-account-id]').textContent=currentUser.orcid;
      const record=header.querySelector('[data-orcid-record]');record.href='https://orcid.org/'+currentUser.orcid;record.setAttribute('aria-label','View ORCID record '+currentUser.orcid);
    }else{button.removeAttribute('aria-controls');button.removeAttribute('aria-expanded');}
    menu.hidden=true;updateAuthVisibility();
  };
  window.addEventListener('papers:auth',renderAccount);
  button?.addEventListener('click',async()=>{await authReady;if(currentUser){menu.hidden=!menu.hidden;button.setAttribute('aria-expanded',String(!menu.hidden));}else await startSignIn();});
  header?.querySelector('[data-audio-settings]')?.addEventListener('click',()=>{closeAccount();openAudioSettings();});
  header?.querySelector('[data-signout]')?.addEventListener('click',async event=>{
    const control=event.currentTarget;control.disabled=true;
    try{const response=await fetch('/auth/logout',{method:'POST',credentials:'same-origin'});if(!response.ok)throw new Error('Sign-out failed');setGuest();renderAccount();button.focus();toast('You have signed out.');}
    catch{toast('Sign-out could not be completed. Please try again.');}finally{control.disabled=false;}
  });
  document.addEventListener('click',event=>{if(menu && !menu.hidden && !header.contains(event.target))closeAccount();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape' && menu && !menu.hidden)closeAccount(true);});
  updateAuthVisibility();await authReady;renderAccount();
  const authResult=new URLSearchParams(window.location.search).get('auth');
  if(authResult==='success' || authResult==='cancelled'){
    toast(authResult==='cancelled'?'ORCID sign-in was cancelled. You can try again whenever you are ready.':currentUser?`Welcome, ${currentUser.name || 'Researcher'}.`:'Your ORCID session could not be confirmed. Please sign in again.');
    const cleanUrl=new URL(window.location.href);cleanUrl.searchParams.delete('auth');window.history.replaceState(null,'',cleanUrl.pathname+cleanUrl.search+cleanUrl.hash);
  }
}
