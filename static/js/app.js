import {icon,escapeHTML,arxivId,pdfUrl,normalizePaper,loadSaved,isSaved,toggleSaved,selectPaper,readSelectedPaper,readUrl,questUrl,shortAuthors,formatDate,toast,mountShell,listenToPaper,stopSpeech,authReady,isAuthenticated,requireSignIn,openAudioSettings} from './core.js?v=github-2';
import { initializeHero } from './hero.js?v=github-2';
import { setupSearchUI } from './search-ui.js?v=github-2';

const $ = id => document.getElementById(id);
const page = document.body.dataset.page;
const featured = (window.EasyArxivPapers?.featured || []).map(normalizePaper).filter(Boolean);
let visiblePapers = [...featured];
let catalogAbort = null, catalogRequest = 0, catalogItems = [], catalogTotal = 0, catalogMore = false;
let selectedSavedId = new URLSearchParams(location.search).get('paper') || '';

mountShell();
document.querySelectorAll('[data-icon]').forEach(el => { el.outerHTML = icon(el.dataset.icon); });

function updateSavedCounts() {
  const count=loadSaved().length;
  document.querySelectorAll('[data-saved-count]').forEach(el=>{el.textContent=count?String(count):'';});
  document.querySelectorAll('[data-save]').forEach(button=>{
    const saved=isSaved(button.dataset.save);
    button.hidden=!isAuthenticated();
    button.classList.toggle('is-saved',saved); button.setAttribute('aria-pressed',String(saved));
    const paper=visiblePapers.find(p=>p.id===button.dataset.save);
    button.setAttribute('aria-label',`${saved?'Remove from saved papers:':'Save paper:'} ${paper?.title || 'research paper'}`);
  });
}

function paperRow(paper) {
  const validDate=!Number.isNaN(new Date(paper.published).getTime());
  const year=validDate?new Date(paper.published).getUTCFullYear():'—';
  const day=validDate?formatDate(paper.published,{year:undefined}):'';
  const saved=isSaved(paper.id);
  return `<article class="paper-row" data-paper="${escapeHTML(paper.id)}"><div class="paper-date-rail"><strong>${year}</strong><span>${escapeHTML(day)}</span><span class="paper-tag">${escapeHTML(paper.category)}</span></div><div class="paper-content"><div class="paper-heading"><h3><a href="${readUrl(paper)}" data-read="${escapeHTML(paper.id)}">${escapeHTML(paper.title)}</a></h3><button type="button" data-auth-only class="icon-button ${saved?'is-saved':''}" data-save="${escapeHTML(paper.id)}" aria-pressed="${saved}" aria-label="${saved?'Remove from saved papers:':'Save paper:'} ${escapeHTML(paper.title)}">${icon('bookmark')}</button></div><p class="paper-authors">${escapeHTML(shortAuthors(paper))}</p><p class="paper-summary">${escapeHTML(paper.summary || 'Open the original paper on arXiv for the full text.')}</p><div class="paper-actions"><button type="button" class="text-link" data-listen="${escapeHTML(paper.id)}" aria-pressed="false">${icon('volume')}<span>Listen to abstract</span></button><a class="text-link" href="${escapeHTML(questUrl(paper))}" data-quest="${escapeHTML(paper.id)}">${icon('spark')}AI Quest</a><a class="btn btn-primary" href="${escapeHTML(paper.pdf_url)}" target="_blank" rel="noopener noreferrer">${icon('file')}Open PDF <span aria-hidden="true">↗</span></a></div></div></article>`;
}

function rememberQuery() { try { sessionStorage.setItem('easy-arxiv-web:lastQuery',location.search); } catch {} }
function openSearch(value) {
  const query=value.trim();
  const error=$('searchError');
  if (!query) { error.textContent='Enter a topic, paper title, author or arXiv link.'; error.hidden=false; $('searchInput').focus(); return; }
  error.hidden=true;
  const id=arxivId(query);
  if (id) {
    const known=featured.find(p=>p.id===id.replace(/v\d+$/,'')) || loadSaved().find(p=>p.id===id.replace(/v\d+$/,''));
    if (known) selectPaper(known);
    location.assign(`/read?paper=${encodeURIComponent(id)}`); return;
  }
  if (/^https?:\/\//i.test(query)) { error.textContent='Paste an arXiv paper link, or enter a research topic as text.'; error.hidden=false; return; }
  if (page==='papers') {
    const url=new URL(location.href); url.searchParams.set('q',query);
    history.pushState({},'',url);catalogUrlFromControls();loadCatalog();
  } else {
    const params=new URLSearchParams({q:query});
    const filters=searchUI?.filterValues();
    if(filters?.from)params.set('from',filters.from);if(filters?.to)params.set('to',filters.to);
    if(filters?.sort && filters.sort!=='relevance')params.set('sort',filters.sort);
    location.assign('/papers?'+params);
  }
}

const searchUI=setupSearchUI({onSearch:openSearch,papers:featured,onFiltersApplied:()=>{
  if(page==='papers'){catalogUrlFromControls();loadCatalog();}
  else if($('searchInput').value.trim())openSearch($('searchInput').value);
}});

document.addEventListener('click',async event=>{
  const save=event.target.closest('[data-save]');
  if (save) { const p=visiblePapers.find(p=>p.id===save.dataset.save) || loadSaved().find(p=>p.id===save.dataset.save); if(p){save.disabled=true;try{await toggleSaved(p);}finally{save.disabled=false;updateSavedCounts();}} return; }
  const listen=event.target.closest('[data-listen]');
  if (listen) { const p=visiblePapers.find(p=>p.id===listen.dataset.listen); if(p)listenToPaper(p,listen); return; }
  const link=event.target.closest('[data-read],[data-quest]');
  if(link) { const p=visiblePapers.find(p=>p.id===(link.dataset.read||link.dataset.quest)); if(p)selectPaper(p); rememberQuery(); }
});
window.addEventListener('papers:saved',()=>{
  updateSavedCounts();
  if(page==='saved')renderSaved($('savedWorkspace').contains(document.activeElement));
  if(page==='reader' && $('readerSave') && visiblePapers[0]) {
    const saved=isSaved(visiblePapers[0].id);
    $('readerSave').setAttribute('aria-pressed',String(saved));
    $('readerSave').querySelector('span').textContent=!isAuthenticated()?'Sign in to save':saved?'Saved to your papers':'Save paper';
  }
});
updateSavedCounts();

window.addEventListener('papers:auth',()=>{
  updateSavedCounts();
  document.querySelectorAll('[data-auth-only]').forEach(el=>el.hidden=!isAuthenticated());
  if(page==='saved')renderSaved();
  if(page==='reader' && $('readerSave') && visiblePapers[0]) {
    const saved=isSaved(visiblePapers[0].id);$('readerSave').setAttribute('aria-pressed',String(saved));
    $('readerSave').querySelector('span').textContent=!isAuthenticated()?'Sign in to save':saved?'Saved to your papers':'Save paper';
  }
});

if(page==='home') {
  $('featuredPapers').innerHTML=featured.map(paperRow).join('');updateSavedCounts();initializeHero({featured});
}

function catalogParams() {
  const params=new URLSearchParams(location.search);
  return {q:params.get('q')||'',sort:params.get('sort')||(params.get('q')?'relevance':'newest'),from:params.get('from')||'',to:params.get('to')||''};
}
function syncCatalogControls() {
  const params=catalogParams();$('searchInput').value=params.q;
  $('sortBy').value=['newest','oldest','relevance'].includes(params.sort)?params.sort:'relevance';
  $('dateFrom').value=params.from;$('dateTo').value=params.to;
  searchUI?.sync();searchUI?.updateFilterBadge();
}
function catalogUrlFromControls() {
  const url=new URL(location.href);
  url.searchParams.set('sort',$('sortBy').value);
  for(const [key,id]of[['from','dateFrom'],['to','dateTo']]) {
    const v=$(id).value; if(v)url.searchParams.set(key,v);else url.searchParams.delete(key);
  }
  history.pushState({},'',url);
}
async function loadCatalog(append=false) {
  const params=catalogParams();
  const id=++catalogRequest;
  catalogAbort?.abort(); catalogAbort=new AbortController(); const controller=catalogAbort;
  let timedOut=false;
  const timeout=setTimeout(()=>{timedOut=true;controller.abort();},45000);
  $('paperResults').setAttribute('aria-busy','true');$('loadMore').disabled=true;
  $('resultsHeading').textContent=params.q?`Results for “${params.q}”`:'Recent papers';
  $('resultSummary').textContent='Searching arXiv…';
  if(!append) {stopSpeech();catalogItems=[];if($('paperResults').querySelector('.paper-row'))$('paperResults').classList.add('is-refreshing');else $('paperResults').innerHTML='<div class="loading-state"><span class="spinner" aria-hidden="true"></span>Finding research papers…</div>';$('pagination').hidden=true;}
  const query=new URLSearchParams({start:String(append?catalogItems.length:0),max_results:'12',sort_by:params.sort==='relevance'?'relevance':'submittedDate',sort_order:params.sort==='oldest'?'ascending':'descending'});
  if(params.q)query.set('query',params.q);else query.set('sort_by','submittedDate');
  if(params.from)query.set('date_from',params.from);if(params.to)query.set('date_to',params.to);
  try {
    const response=await fetch((params.q?'/api/search_papers?':'/api/recent_papers?')+query,{signal:controller.signal});
    const data=await response.json();
    if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'arXiv is unavailable. Please try again.');
    if(id!==catalogRequest)return;
    const fetched=(Array.isArray(data.papers)?data.papers:[]).map(normalizePaper).filter(Boolean);
    catalogItems=append?[...catalogItems,...fetched]:fetched;
    catalogItems=[...new Map(catalogItems.map(p=>[p.id,p])).values()];
    visiblePapers=[...catalogItems];catalogTotal=Number(data.total)||catalogItems.length;catalogMore=typeof data.has_more==='boolean'?data.has_more:catalogItems.length<catalogTotal;
    stopSpeech();
    $('paperResults').innerHTML=catalogItems.length?catalogItems.map(paperRow).join(''):`<div class="empty-state">${icon('search')}<h2>No papers found.</h2><p>Try a broader topic, check the spelling, or clear your date filters.</p><button class="btn btn-secondary" id="broaderSearch" type="button">Clear dates and try again</button></div>`;
    $('broaderSearch')?.addEventListener('click',()=>{$('dateFrom').value='';$('dateTo').value='';catalogUrlFromControls();loadCatalog();});
    $('resultSummary').textContent=`${catalogItems.length.toLocaleString()} of ${catalogTotal.toLocaleString()} papers from arXiv`;
    $('pagination').hidden=!catalogMore || !catalogItems.length;
    $('pageCount').textContent=`Showing ${catalogItems.length} of ${catalogTotal.toLocaleString()} papers`;
    updateSavedCounts();rememberQuery();
  } catch(error) {
    if(id!==catalogRequest || (error.name==='AbortError'&&!timedOut))return;
    const description=timedOut?'The request took too long. Please try again in a moment.':error.message==='Failed to fetch'?'Check your connection and try again.':error.message;
    $('resultSummary').textContent='Search could not finish.';
    if(!append)$('paperResults').innerHTML=`<div class="empty-state">${icon('file')}<h2>Let’s try that again.</h2><p>${escapeHTML(description)}</p><button class="btn btn-primary" type="button" id="retrySearch">Retry search</button><button class="text-link" type="button" id="showFeatured">Explore handpicked papers →</button></div>`;
    else toast(description);
    $('retrySearch')?.addEventListener('click',()=>loadCatalog());
    $('showFeatured')?.addEventListener('click',()=>{catalogItems=featured;visiblePapers=featured;$('paperResults').innerHTML=featured.map(paperRow).join('');$('resultsHeading').textContent='Handpicked starting points';$('resultSummary').textContent='Editorial selections · live search is unavailable right now.';$('pagination').hidden=true;updateSavedCounts();});
  } finally {
    clearTimeout(timeout);if(id===catalogRequest){$('paperResults').setAttribute('aria-busy','false');$('paperResults').classList.remove('is-refreshing');$('loadMore').disabled=false;}
  }
}
if(page==='papers') {
  syncCatalogControls();
  $('sortBy').addEventListener('change',()=>{catalogUrlFromControls();loadCatalog();});
  $('loadMore').addEventListener('click',()=>loadCatalog(true));
  window.addEventListener('popstate',()=>{syncCatalogControls();loadCatalog();});
  window.addEventListener('pagehide',()=>catalogAbort?.abort());
  if(location.hash==='#filters')searchUI?.openFilters();
  loadCatalog();
}

function renderSaved(restoreFocus=false) {
  stopSpeech();
  if(!isAuthenticated()){$('savedWorkspace').innerHTML=`<div class="empty-state saved-auth-gate">${icon('bookmark')}<h2>A reading list of your own.</h2><p>Sign in with ORCID to save papers and return to your collection.</p><button class="btn btn-primary" id="savedSignIn" type="button">Login with ORCID ${icon('arrow')}</button></div>`;$('savedSignIn').addEventListener('click',()=>requireSignIn('Sign in to view your saved papers.'));return;}
  const papers=loadSaved();visiblePapers=papers;
  if(!papers.length) {$('savedWorkspace').innerHTML=`<div class="empty-state">${icon('bookmark')}<h2>Your next reading session starts here.</h2><p>Save a paper with its bookmark button. It will be kept with your ORCID account, ready whenever you return.</p><a class="btn btn-primary" href="/papers">Explore papers ${icon('arrow')}</a></div>`;return;}
  const selected=papers.find(p=>p.id===selectedSavedId)||papers[0];selectedSavedId=selected.id;
  $('savedWorkspace').innerHTML=`<section class="saved-desk" aria-label="Your reading desk"><aside class="saved-sidebar"><h2>${icon('bookmark')}Saved papers</h2><ul class="saved-options">${papers.map(p=>`<li><button type="button" class="saved-paper-select" data-select-saved="${escapeHTML(p.id)}" aria-current="${p.id===selected.id}"><strong>${escapeHTML(p.title)}</strong><small>${escapeHTML(shortAuthors(p,1))} · ${new Date(p.published).getFullYear()||'arXiv'}</small></button></li>`).join('')}</ul></aside><article class="saved-reader"><div class="saved-reader-top"><span>Reading desk</span><a class="btn btn-primary" href="${escapeHTML(selected.pdf_url)}" target="_blank" rel="noopener noreferrer">${icon('file')}Open PDF</a></div><div class="saved-reader-body"><div class="saved-meta"><span>${escapeHTML(selected.category)} · ${formatDate(selected.published,{day:undefined,month:undefined})}</span><button type="button" id="removeSaved" aria-label="Remove this paper from saved papers">${icon('bookmark')}Saved</button></div><h2>${escapeHTML(selected.title)}</h2><p class="paper-authors">${escapeHTML(selected.authors.join(', '))}</p><h3 class="abstract-label">${escapeHTML(selected.summary_label)}</h3><p class="saved-abstract">${escapeHTML(selected.summary || 'Open the original PDF to read this research paper.')}</p><div class="audio-strip"><button class="listen-control" id="savedListen" type="button" aria-pressed="false">${icon('play')}<span>Listen to abstract<small>${escapeHTML(selected.title.length>50?selected.title.slice(0,47)+'…':selected.title)}</small></span></button><span class="audio-ornament" aria-hidden="true"></span><button class="text-link" id="savedVoiceSettings" type="button">Voice settings</button></div><div class="saved-bottom-links"><a class="text-link" data-read="${escapeHTML(selected.id)}" href="${readUrl(selected)}">Read paper ${icon('arrow')}</a><a class="text-link" data-quest="${escapeHTML(selected.id)}" href="${escapeHTML(questUrl(selected))}">${icon('spark')}Explore with AI Quest</a></div></div></article></section>`;
  document.querySelectorAll('[data-select-saved]').forEach(button=>button.addEventListener('click',()=>{selectedSavedId=button.dataset.selectSaved;renderSaved(true);}));
  $('removeSaved').addEventListener('click',()=>toggleSaved(selected));
  $('savedListen').addEventListener('click',event=>listenToPaper(selected,event.currentTarget));
  $('savedVoiceSettings').addEventListener('click',openAudioSettings);
  if(restoreFocus)document.querySelector('[data-select-saved][aria-current="true"]')?.focus({preventScroll:true});
}
if(page==='saved'){ $('savedWorkspace').innerHTML='<div class="loading-state"><span class="spinner" aria-hidden="true"></span>Opening your reading list…</div>';authReady.then(()=>renderSaved()); }

function showReader(paper) {
  visiblePapers=[paper];selectPaper(paper);document.title=paper.title+' · Easy ArXiv';
  $('paperReader').setAttribute('aria-busy','false');
  $('paperReader').innerHTML=`<div class="reader-layout"><article class="article-sheet"><div class="article-meta"><span class="paper-tag">${escapeHTML(paper.category)}</span><span>${escapeHTML(formatDate(paper.published))}</span><a class="btn btn-secondary" href="${escapeHTML(questUrl(paper))}" data-quest="${escapeHTML(paper.id)}">${icon('spark')}AI Quest</a></div><h1>${escapeHTML(paper.title)}</h1><p class="article-authors">${escapeHTML(paper.authors.join(', '))}</p><hr class="article-divider"><h2>${escapeHTML(paper.summary_label)}</h2><div class="article-abstract">${(paper.summary||'The abstract is unavailable. Open the original PDF for the full research paper.').split(/\n\s*\n/).map(p=>'<p>'+escapeHTML(p)+'</p>').join('')}</div>${paper.summary_label==='Editorial overview'?'<p class="source-description">A handpicked paper with an editorial overview. Read the original for the full research.</p>':''}<div class="article-actions"><button class="text-link" data-listen="${escapeHTML(paper.id)}" type="button" aria-pressed="false">${icon('volume')}<span>Listen to abstract</span></button><a class="btn btn-primary" href="${escapeHTML(paper.pdf_url)}" target="_blank" rel="noopener noreferrer">${icon('file')}Open full PDF ${icon('external')}</a></div></article><aside class="reader-aside"><h2>Your reading space</h2><p>Keep this paper close for your next reading session.</p><button class="btn btn-secondary" id="readerSave" type="button">${icon('bookmark')}<span>${!isAuthenticated()?'Sign in to save':isSaved(paper.id)?'Saved to your papers':'Save paper'}</span></button><a class="btn btn-secondary" data-auth-only href="/saved">View saved papers ${icon('arrow')}</a><p class="reader-fine">arXiv:${escapeHTML(paper.id)}<br><a class="text-link" href="${escapeHTML(paper.link)}" target="_blank" rel="noopener noreferrer">Original arXiv record ${icon('external')}</a></p></aside></div>`;
  $('readerSave').setAttribute('aria-pressed',String(isSaved(paper.id)));
  $('readerSave').addEventListener('click',async()=>{const button=$('readerSave');button.disabled=true;try{await toggleSaved(paper);}finally{button.disabled=false;}});
  $('readerSave').closest('.reader-aside').querySelector('[data-auth-only]').hidden=!isAuthenticated();
}
async function loadReader() {
  const params=new URLSearchParams(location.search),id=arxivId(params.get('paper')||params.get('pdf')||'');
  if(!id){$('paperReader').innerHTML=`<div class="empty-state">${icon('file')}<h2>Choose a paper to begin.</h2><p>Open a paper from your search results or saved papers.</p><a class="btn btn-primary" href="/papers">Explore papers ${icon('arrow')}</a></div>`;$('paperReader').setAttribute('aria-busy','false');return;}
  const key=id.replace(/v\d+$/,'');
  const selected=readSelectedPaper();
  const known=(selected?.id===key?selected:null)||loadSaved().find(p=>p.id===key)||featured.find(p=>p.id===key);
  try {const back=sessionStorage.getItem('easy-arxiv-web:lastQuery');if(back?.startsWith('?'))$('readerBack').href='/papers'+back;}catch{}
  if(known){showReader({...known,pdf_url:pdfUrl(id),link:`https://arxiv.org/abs/${id}`});return;}
  try {
    const response=await fetch('/api/paper?pdf='+encodeURIComponent(pdfUrl(id)),{signal:AbortSignal.timeout(40000)});
    const data=await response.json();if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'This paper could not be opened.');
    const paper=normalizePaper(data.paper||data);if(!paper)throw new Error('No paper metadata was returned.');showReader(paper);
  }catch(error){$('paperReader').setAttribute('aria-busy','false');$('paperReader').innerHTML=`<div class="empty-state">${icon('file')}<h2>The paper could not be opened.</h2><p>${escapeHTML(error.name==='TimeoutError'?'arXiv is taking longer than expected.':error.message)}</p><button type="button" class="btn btn-secondary" id="retryReader">Try again</button> <a class="btn btn-primary" href="${escapeHTML(pdfUrl(id))}" target="_blank" rel="noopener noreferrer">Open original PDF ${icon('external')}</a></div>`;$('retryReader').addEventListener('click',loadReader);}
}
if(page==='reader')loadReader();
