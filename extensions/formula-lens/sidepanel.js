import {pdfSource, validSelection, isLocalPreview} from './selection.js';

export function createFormulaPanelBridge({api = globalThis.chrome, doc = globalThis.document,
    href = globalThis.location?.href || ''} = {}) {
  const byId = id => doc.getElementById(id);
  const navigatingTabs = new Set();
  let activeTabId = null, revision = 0;
  const emit = (name, detail) => doc.dispatchEvent(new CustomEvent(name, {detail}));

  function sourceLink(source) {
    const link = byId('selectedSource');
    if (!link) return;
    link.textContent = source?.label || '';
    if (source?.originalUrl) {
      link.href = source.originalUrl;
      link.hidden = false;
    } else {
      link.removeAttribute('href');
      link.hidden = true;
    }
  }

  function clearSelection(message = '') {
    sourceLink(null);
    const feedback = byId('selectionFeedback');
    if (feedback) feedback.textContent = message;
    emit('formula-clear', {message});
  }

  function applyRecord(record) {
    const source = pdfSource(record?.originalUrl);
    if (!source || record.sourceId !== source.sourceId || !validSelection(record.rawText)) {
      clearSelection(); return;
    }
    sourceLink(source);
    emit('formula-selection', {rawText: record.rawText, source});
  }

  async function refresh() {
    const current = ++revision;
    try {
      const tabs = await api.tabs.query({active: true, currentWindow: true});
      if (current !== revision) return;
      const tab = tabs[0];
      activeTabId = Number.isSafeInteger(tab?.id) && tab.id >= 0 ? tab.id : null;
      if (activeTabId === null || navigatingTabs.has(activeTabId) || tab.status === 'loading') {
        clearSelection(); return;
      }
      if (typeof tab.url === 'string' && !pdfSource(tab.url)) {
        clearSelection(tab.url.startsWith('file:')
          ? 'Local PDFs (file://) are not supported yet. Open a PDF over HTTPS or enter an expression manually.'
          : 'Open a PDF over HTTPS, select an equation, and choose “Explore formula · Easy ArXiv”.');
        return;
      }
      const key = `formula:${activeTabId}`;
      const data = await api.storage.session.get(key);
      if (current !== revision) return;
      if (typeof tab.url === 'string' && data[key]?.originalUrl !== tab.url) {clearSelection(); return;}
      applyRecord(data[key]);
    } catch {
      if (current === revision) clearSelection('Open a PDF over HTTPS and choose “Explore formula · Easy ArXiv” from the selection context menu.');
    }
  }

  if (api?.runtime?.id && api?.storage?.session && api?.tabs) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && activeTabId !== null && Object.hasOwn(changes, `formula:${activeTabId}`)) void refresh();
    });
    api.tabs.onActivated.addListener(() => {revision++; clearSelection(); void refresh();});
    api.tabs.onUpdated.addListener((tabId, change) => {
      if (change.status === 'loading') navigatingTabs.add(tabId);
      if (typeof change.url === 'string' || change.status === 'loading') {
        if (tabId === activeTabId) {revision++; clearSelection();}
      }
      if (change.status === 'complete') {
        navigatingTabs.delete(tabId);
        if (tabId === activeTabId) void refresh();
      }
    });
    api.tabs.onRemoved?.addListener(tabId => {
      navigatingTabs.delete(tabId);
      if (tabId === activeTabId) {revision++; activeTabId = null; clearSelection();}
    });
    void refresh();
  } else if (isLocalPreview(href)) {
    const badge = byId('previewBadge');
    if (badge) badge.hidden = false;
    clearSelection('Local interface preview. Use “Try a worked example” to explore the sample.');
  } else {
    clearSelection('This panel runs as a Chrome extension. Open the original PDF over HTTPS or enter an expression manually.');
  }
  return {refresh};
}

if (globalThis.document) createFormulaPanelBridge();
