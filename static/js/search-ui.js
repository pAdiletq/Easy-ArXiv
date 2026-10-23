import { icon, escapeHTML } from './core.js?v=github-2';

export const researchTopics = [
  'Artificial intelligence','Quantum computing','Machine learning','Climate science','Neuroscience',
  'Computer vision','Astrophysics','Renewable energy','Robotics','Number theory','Bioinformatics',
  'Natural language processing','Materials science','Graph neural networks','Particle physics',
  'Medical imaging','Quantum information','Statistical learning','Gravitational waves','Computational biology',
  'Fluid dynamics','Reinforcement learning','Cryptography','Cosmology','Optimization','Solar cells',
  'Protein folding','Data privacy','Quantum optics','Dynamical systems','Explainable AI','Nuclear physics',
  'Language models','Signal processing','Network science','Algebraic geometry','Condensed matter',
];

export function chooseTopics(previous = [], random = Math.random) {
  const pool = researchTopics.filter(topic => !previous.includes(topic));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, 3);
}

export function localSuggestions(query, papers = []) {
  const text = query.trim().toLowerCase();
  if (text.length < 2) return [];
  const topics = researchTopics.filter(topic => topic.toLowerCase().includes(text)).map(label => ({type:'topic',label,value:label}));
  const matches = papers.filter(p => p.title.toLowerCase().includes(text)).map(p => ({type:'paper',label:p.title,value:p.id,authors:p.authors?.slice(0,2).join(', ')}));
  const rank=item=>item.label.toLowerCase().startsWith(text)?0:item.label.toLowerCase().split(/\s+/).some(word=>word.startsWith(text))?1:2;
  return [...matches, ...topics].sort((a,b)=>rank(a)-rank(b)).slice(0, 6);
}

export function setupSearchUI({ onSearch, onFiltersApplied = () => {}, papers = [] }) {
  const input = document.getElementById('searchInput');
  if (!input) return null;
  const form = input.closest('form');
  const panel = input.closest('.search-panel');
  const intro = panel?.querySelector('.search-panel-intro');
  const field = input.closest('.search-input-wrap');
  const anchor = document.createElement('div'); anchor.className = 'autocomplete-anchor';
  field.before(anchor); anchor.append(field);
  const popup = document.createElement('div'); popup.className = 'search-suggestions'; popup.id = 'searchSuggestions'; popup.hidden = true;
  popup.innerHTML = '<div class="suggestions-caption">SUGGESTIONS <span>↑ ↓ to choose · Enter to search</span></div><div role="listbox" id="suggestionList" aria-label="Research suggestions"></div>';
  anchor.append(popup);
  const list = popup.querySelector('[role=listbox]');
  input.setAttribute('role','combobox'); input.setAttribute('aria-autocomplete','list');
  input.setAttribute('aria-controls','suggestionList'); input.setAttribute('aria-expanded','false');
  let choices = [], active = -1, debounce, abort, request = 0, topicTimer, topicFade;
  let lastTopics = [];
  const motion = matchMedia('(prefers-reduced-motion: reduce)');

  function closeSuggestions() {
    popup.hidden = true; input.setAttribute('aria-expanded','false'); input.removeAttribute('aria-activedescendant'); active = -1;
  }
  function sync() {
    const editing = Boolean(input.value.trim());
    panel?.classList.toggle('is-editing',editing);
    if (intro) { intro.inert = editing; intro.setAttribute('aria-hidden',String(editing)); }
    document.getElementById('searchError')?.setAttribute('hidden','');
  }
  function highlight(label) {
    const q = input.value.trim(), index = label.toLowerCase().indexOf(q.toLowerCase());
    if (index < 0) return escapeHTML(label);
    return escapeHTML(label.slice(0,index)) + '<mark>' + escapeHTML(label.slice(index,index+q.length)) + '</mark>' + escapeHTML(label.slice(index+q.length));
  }
  function renderSuggestions(items) {
    choices = [...new Map(items.filter(i => i && typeof i.label==='string' && typeof i.value==='string').map(i=>[i.value.toLowerCase(),i])).values()].slice(0,6);
    if (!choices.length) choices=[{type:'search',label:input.value.trim(),value:input.value.trim()}];
    active=-1;
    list.innerHTML=choices.map((item,index)=>`<div role="option" tabindex="-1" id="suggestion-${index}" aria-selected="false" data-suggestion="${index}"><span class="suggestion-icon">${icon(item.type==='paper'?'file':'search')}</span><span class="suggestion-copy"><strong>${highlight(item.label)}</strong><small>${escapeHTML(item.type==='paper' ? item.authors || 'Research paper on arXiv' : item.type==='topic' ? 'Research topic' : 'Search arXiv for this phrase')}</small></span>${icon('arrow')}</div>`).join('');
    popup.hidden=false; input.setAttribute('aria-expanded','true'); input.removeAttribute('aria-activedescendant');
  }
  function select(index) {
    const choice=choices[index]; if(!choice)return;
    input.value=choice.value; sync(); closeSuggestions(); abort?.abort(); onSearch(choice.value);
  }
  function markActive(index) {
    active=(index+choices.length)%choices.length;
    [...list.children].forEach((option,i)=>option.setAttribute('aria-selected',String(i===active)));
    input.setAttribute('aria-activedescendant',`suggestion-${active}`);
    list.children[active]?.scrollIntoView({block:'nearest'});
  }
  async function suggest() {
    const query=input.value.trim(); if(query.length<2){closeSuggestions();return;}
    const current=++request; abort?.abort(); abort=new AbortController();
    const initial=localSuggestions(query,papers); renderSuggestions(initial);
    try {
      const response=await fetch('/api/suggestions?query='+encodeURIComponent(query),{signal:abort.signal});
      if(!response.ok)return;
      const data=await response.json();
      if(current!==request || document.activeElement!==input || input.value.trim()!==query)return;
      const remote=Array.isArray(data.suggestions)?data.suggestions:[];
      renderSuggestions([...initial,...remote]);
    } catch { /* Local suggestions remain usable if arXiv is offline. */ }
  }
  input.addEventListener('input',()=>{
    sync(); clearTimeout(debounce); abort?.abort(); request++;
    if(input.value.trim().length<2){closeSuggestions();return;}
    renderSuggestions(localSuggestions(input.value,papers));
    debounce=setTimeout(suggest,260);
  });
  input.addEventListener('focus',()=>{if(input.value.trim().length>=2)suggest();});
  input.addEventListener('keydown',event=>{
    if(event.key==='Escape'){closeSuggestions();abort?.abort();request++;return;}
    if((event.key==='ArrowDown'||event.key==='ArrowUp') && !popup.hidden && choices.length){event.preventDefault();markActive(active+(event.key==='ArrowDown'?1:-1));}
    if(event.key==='Enter' && !popup.hidden && active>=0){event.preventDefault();select(active);}
  });
  list.addEventListener('pointerdown',event=>{if(event.target.closest('[data-suggestion]'))event.preventDefault();});
  list.addEventListener('click',event=>{const option=event.target.closest('[data-suggestion]');if(option)select(Number(option.dataset.suggestion));});
  document.addEventListener('click',event=>{if(!anchor.contains(event.target))closeSuggestions();});
  document.addEventListener('focusin',event=>{if(!anchor.contains(event.target))closeSuggestions();});
  form.addEventListener('submit',event=>{event.preventDefault();closeSuggestions();abort?.abort();onSearch(input.value);});

  const examples=panel?.querySelector('.search-examples');
  function rotateTopics(initial=false) {
    if(!examples || document.hidden || examples.contains(document.activeElement) || (!initial && examples.matches(':hover')))return;
    lastTopics=chooseTopics(lastTopics);
    const apply=()=>{
      examples.innerHTML='<span>Try a topic</span>'+lastTopics.map(topic=>`<button type="button" data-topic="${escapeHTML(topic)}">${escapeHTML(topic)}</button>`).join('');
      examples.classList.remove('is-changing');
    };
    if(initial || motion.matches)apply();
    else {examples.classList.add('is-changing');topicFade=setTimeout(apply,220);}
  }
  examples?.addEventListener('click',event=>{
    const button=event.target.closest('[data-topic]');if(!button)return;
    input.value=button.dataset.topic;sync();closeSuggestions();onSearch(input.value);
  });
  rotateTopics(true); topicTimer=setInterval(()=>rotateTopics(),13000);

  // The same filter sheet works on the home search and in the catalog.
  document.getElementById('dateFilters')?.remove();
  const dialog=document.createElement('dialog'); dialog.id='filterDialog'; dialog.className='filter-dialog';
  dialog.setAttribute('aria-labelledby','filterTitle');
  dialog.innerHTML=`<form id="dateFilters" class="filter-sheet" novalidate><div class="filter-sheet-header"><span class="filter-heading-icon">${icon('filter')}</span><div><h2 id="filterTitle">Refine your search</h2><p>A little less noise. More relevant research.</p></div><button class="icon-button" type="button" data-close-filters aria-label="Close filters">${icon('close')}</button></div><div class="filter-sheet-body"><label class="filter-field">Order papers<select id="filterSort"><option value="relevance">Most relevant</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label><fieldset class="date-presets"><legend>Publication date</legend><button type="button" data-date-preset="all">Any time</button><button type="button" data-date-preset="year">Past year</button><button type="button" data-date-preset="five">Past 5 years</button></fieldset><div class="filter-date-grid"><label class="filter-field">From<input type="date" id="dateFrom" name="from"></label><label class="filter-field">To<input type="date" id="dateTo" name="to"></label></div><p class="filter-hint">Leave either date open to search the full archive.</p><p class="form-error" id="dateError" role="alert" hidden></p></div><div class="filter-sheet-footer"><button type="button" class="text-link" id="clearDates">Reset filters</button><button type="submit" class="btn btn-primary">Apply filters ${icon('check')}</button></div></form>`;
  document.body.append(dialog);
  const from=document.getElementById('dateFrom'), to=document.getElementById('dateTo'), sort=document.getElementById('filterSort');
  const error=document.getElementById('dateError');
  let closeTimer, filterSnapshot;
  function updateFilterBadge() {
    const selectedSort=document.getElementById('sortBy')?.value||sort.value;
    const baseline=document.body.dataset.page==='papers'&&!input.value.trim()?'newest':'relevance';
    const count=Number(Boolean(from.value||to.value))+Number(selectedSort!==baseline);
    document.querySelectorAll('[data-search-filters],#dateToggle').forEach(button=>{
      button.classList.toggle('has-filters',count>0);button.setAttribute('data-filter-count',String(count));
      button.setAttribute('aria-expanded',String(dialog.open)); button.setAttribute('aria-controls','filterDialog');
    });
  }
  function closeFilters(apply=false) {
    if(!apply && filterSnapshot){from.value=filterSnapshot.from;to.value=filterSnapshot.to;sort.value=filterSnapshot.sort;}
    dialog.classList.remove('is-open'); clearTimeout(closeTimer);
    closeTimer=setTimeout(()=>{dialog.close();updateFilterBadge();},motion.matches?0:180);
  }
  function openFilters() {
    closeSuggestions();clearTimeout(closeTimer);error.hidden=true;
    const globalSort=document.getElementById('sortBy');if(globalSort)sort.value=globalSort.value;
    filterSnapshot={from:from.value,to:to.value,sort:sort.value};
    dialog.showModal();requestAnimationFrame(()=>dialog.classList.add('is-open'));updateFilterBadge();
  }
  document.querySelectorAll('[data-search-filters],#dateToggle').forEach(button=>button.addEventListener('click',openFilters));
  dialog.querySelector('[data-close-filters]').addEventListener('click',()=>closeFilters());
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeFilters();});
  dialog.addEventListener('click',event=>{if(event.target===dialog)closeFilters();});
  dialog.querySelectorAll('[data-date-preset]').forEach(button=>button.addEventListener('click',()=>{
    const now=new Date(); to.value=''; from.value='';
    if(button.dataset.datePreset!=='all') {now.setUTCFullYear(now.getUTCFullYear()-(button.dataset.datePreset==='five'?5:1));from.value=now.toISOString().slice(0,10);}
    dialog.querySelectorAll('[data-date-preset]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
    error.hidden=true;
  }));
  document.getElementById('clearDates').addEventListener('click',()=>{from.value='';to.value='';sort.value=document.body.dataset.page==='papers'&&!input.value.trim()?'newest':'relevance';error.hidden=true;dialog.querySelectorAll('[data-date-preset]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.datePreset==='all')));});
  dialog.querySelector('form').addEventListener('submit',event=>{
    event.preventDefault();
    if(from.value&&to.value&&from.value>to.value){error.textContent='The start date must be before the end date.';error.hidden=false;from.focus();return;}
    const globalSort=document.getElementById('sortBy');if(globalSort)globalSort.value=sort.value;
    closeFilters(true);updateFilterBadge();onFiltersApplied();
  });
  sync();
  window.addEventListener('pagehide',()=>{abort?.abort();clearTimeout(debounce);clearTimeout(topicFade);clearTimeout(closeTimer);clearInterval(topicTimer);},{once:true});
  return {sync,openFilters,closeSuggestions,updateFilterBadge,filterValues:()=>({from:from.value,to:to.value,sort:document.getElementById('sortBy')?.value||sort.value})};
}
