import {pdfSource, samePDFDocument, validSelection} from './selection.js';
import {registerPaperMessages} from './paper-fetch.js';

export const FORMULA_MENU_ID = 'easy-arxiv-explore-formula';
export const MAX_FORMULA_TABS = 20;

export function selectedFormulaRecord(info, tab, now = Date.now()) {
  if (info?.menuItemId !== FORMULA_MENU_ID || info.editable || !Number.isSafeInteger(tab?.id) || tab.id < 0 ||
      !validSelection(info.selectionText)) return null;
  // Native PDF selections come from an internal PDF frame. Only the actual
  // top-level tab/page address identifies the PDF; frameUrl is never trusted.
  const fromTab = pdfSource(tab.url);
  if (typeof tab.url === 'string' && tab.url.length > 0 && !fromTab) return null;
  const fromPage = pdfSource(info.pageUrl);
  if (typeof info.pageUrl === 'string' && info.pageUrl.length > 0 && !fromPage) return null;
  if (fromTab && fromPage && !samePDFDocument(fromTab.originalUrl, fromPage.originalUrl)) return null;
  const source = fromTab || fromPage;
  if (!source) return null;
  return {originalUrl: source.originalUrl, sourceId: source.sourceId, rawText: info.selectionText, updatedAt: now};
}

export function createFormulaBackground(api, now = Date.now) {
  let queue = Promise.resolve(), sequence = 0;
  const pending = new Map();
  const keyFor = id => 'formula:' + id;
  const serialize = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => false);
    return queue;
  };

  function clearTab(tabId) {
    if (!Number.isSafeInteger(tabId) || tabId < 0) return Promise.resolve(false);
    pending.delete(tabId);
    return serialize(async () => {await api.storage.session.remove(keyFor(tabId)); return true;});
  }

  function onClick(info, tab) {
    const record = selectedFormulaRecord(info, tab, now());
    if (!record) return Promise.resolve(false);
    const tabId = tab.id, token = ++sequence;
    pending.set(tabId, token);
    let opening;
    try {
      // Must run in this original context-menu gesture, before storage awaits.
      // No script is executed in the PDF and no navigation is performed.
      opening = api.sidePanel.open({tabId});
    } catch {pending.delete(tabId); return Promise.resolve(false);}
    return Promise.resolve(opening).then(() => serialize(async () => {
      try {
        if (pending.get(tabId) !== token) return false;
        const entries = await api.storage.session.get(null);
        if (pending.get(tabId) !== token) return false;
        const previous = Object.entries(entries).filter(([key]) => /^formula:\d+$/.test(key) && key !== keyFor(tabId));
        previous.sort((a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0));
        const evicted = previous.slice(MAX_FORMULA_TABS - 1).map(([key]) => key);
        if (evicted.length) await api.storage.session.remove(evicted);
        if (pending.get(tabId) !== token) return false;
        await api.storage.session.set({[keyFor(tabId)]: record});
        if (pending.get(tabId) !== token) {await api.storage.session.remove(keyFor(tabId)); return false;}
        return true;
      } finally {if (pending.get(tabId) === token) pending.delete(tabId);}
    })).catch(() => {if (pending.get(tabId) === token) pending.delete(tabId); return false;});
  }

  async function registerMenu() {
    try {
      await api.contextMenus.removeAll();
      api.contextMenus.create({id: FORMULA_MENU_ID, title: 'Explore formula · Easy ArXiv', contexts: ['selection']},
        () => {void api.runtime.lastError;});
      // documentUrlPatterns matches the internal frame URL in Chromium. A
      // website filter can hide this item in the ordinary PDF viewer; the
      // click handler instead enforces the strict original top-level URL.
    } catch { /* A failed API registration exposes no selection or document. */ }
  }

  api.runtime.onInstalled.addListener(registerMenu);
  api.runtime.onStartup?.addListener(registerMenu);
  api.contextMenus.onClicked.addListener(onClick);
  api.tabs.onRemoved.addListener(tabId => {void clearTab(tabId);});
  api.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // Inspect only whether navigation happened, never retain its destination.
    if (Object.hasOwn(changeInfo, 'url') || changeInfo.status === 'loading') void clearTab(tabId);
  });
  api.action?.onClicked.addListener(tab => {
    if (!Number.isSafeInteger(tab?.id) || tab.id < 0) return;
    try {Promise.resolve(api.sidePanel.open({tabId: tab.id})).catch(() => {});} catch { /* Keep the native page intact. */ }
  });
  return {onClick, clearTab, registerMenu, flush: () => queue};
}

if (globalThis.chrome?.runtime?.onInstalled && globalThis.chrome?.contextMenus && globalThis.chrome?.sidePanel) {
  createFormulaBackground(globalThis.chrome);
  registerPaperMessages(globalThis.chrome);
}
