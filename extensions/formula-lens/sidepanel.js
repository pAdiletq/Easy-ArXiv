import {arxivPDFSource, classifySelection, isLocalPreview} from './selection.js';

const api = globalThis.chrome;
const byId = id => document.getElementById(id);
let activeTabId = null, revision = 0;

function clearSelection(message = '') {
  byId('activePanel').hidden = true;
  byId('emptyPanel').hidden = false;
  byId('selectionFeedback').textContent = message;
}

function applyRecord(record) {
  const source = arxivPDFSource(record?.originalUrl);
  if (!source || source.paperId !== record?.paperId || typeof record?.text !== 'string' || record.text.length > 2000) {
    clearSelection(); return;
  }
  const recognized = classifySelection(record.text, source.paperId);
  if (!recognized) {
    clearSelection(source.paperId === '1706.03762'
      ? 'Выделите полную формулу (1), включая Attention, softmax, дробь и V. Другие формулы пока не поддерживаются.'
      : 'Для этой статьи пока нет интерактивной модели. В первом патче поддерживается формула (1) из Attention Is All You Need.');
    return;
  }
  byId('selectedSource').href = source.originalUrl;
  byId('selectedSource').textContent = 'Attention Is All You Need · ' + source.versionedId;
  document.dispatchEvent(new CustomEvent('formula-selected', {detail:{...recognized,text:record.text,paperId:source.paperId}}));
}

async function refresh() {
  const current = ++revision;
  try {
    const tabs = await api.tabs.query({active:true,currentWindow:true});
    if (current !== revision) return;
    activeTabId = Number.isSafeInteger(tabs[0]?.id) ? tabs[0].id : null;
    if (activeTabId === null) {clearSelection();return;}
    const key = `formula:${activeTabId}`;
    const data = await api.storage.session.get(key);
    if (current !== revision) return;
    if (typeof tabs[0].url === 'string' && data[key]?.originalUrl !== tabs[0].url) {clearSelection();return;}
    applyRecord(data[key]);
  } catch {if(current===revision)clearSelection('Откройте PDF arXiv и выберите «Разобрать формулу · Easy ArXiv» в контекстном меню выделения.');}
}

if (api?.runtime?.id && api?.storage?.session && api?.tabs) {
  api.storage.onChanged.addListener((changes,area)=>{
    if (area === 'session' && activeTabId !== null && Object.hasOwn(changes,`formula:${activeTabId}`)) void refresh();
  });
  api.tabs.onActivated.addListener(()=>{clearSelection();void refresh();});
  api.tabs.onUpdated.addListener((tabId,change)=>{
    if (tabId===activeTabId && (typeof change.url==='string'||change.status==='loading')) {revision++;clearSelection();}
  });
  void refresh();
} else if (isLocalPreview(location.href)) {
  byId('previewBadge').hidden=false;
  byId('previewExample').hidden=false;
  const ribbon=document.createElement('div');ribbon.className='preview-ribbon';ribbon.textContent='ПРЕДПРОСМОТР ПАНЕЛИ · Штатный просмотрщик PDF остаётся отдельным и не изменяется.';document.body.prepend(ribbon);
  byId('previewExample').addEventListener('click',()=>applyRecord({paperId:'1706.03762',originalUrl:'https://arxiv.org/pdf/1706.03762',text:'Attention(Q, K, V) = softmax(QKT / √dk)V'}));
} else {
  clearSelection('Эта панель работает как расширение Chrome. Откройте исходный PDF arXiv, выделите формулу и выберите «Разобрать формулу · Easy ArXiv».');
}
