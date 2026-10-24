import assert from 'node:assert/strict';
import test from 'node:test';
import {createFormulaBackground, FORMULA_MENU_ID, selectedFormulaRecord} from '../extensions/formula-lens/background.js';

const URL = 'https://arxiv.org/pdf/1706.03762';
const selection = '  F(x) = A*x² + a\n';
const info = (overrides={}) => ({menuItemId:FORMULA_MENU_ID,selectionText:selection,pageUrl:URL,...overrides});
const tab = (id=1, url=URL) => ({id,url});
const clone = value => structuredClone(value);
function event() {
  const listeners=[];
  return {addListener:callback=>listeners.push(callback),emit:(...args)=>Promise.all(listeners.map(callback=>callback(...args)))};
}
function harness({stored={},opening=()=>Promise.resolve(),writeGate=null}={}) {
  const records=clone(stored),calls=[],created=[];
  const api={
    runtime:{onInstalled:event(),onStartup:event(),lastError:null},
    contextMenus:{onClicked:event(),removeAll:async()=>{calls.push('remove-menu');},create:(properties,callback)=>{created.push(properties);callback();}},
    sidePanel:{open:options=>{calls.push(['open',options]);return opening(options);}},
    storage:{session:{
      get:async()=>{calls.push('get-session');return clone(records);},
      set:async values=>{calls.push(['set-session',clone(values)]);if(writeGate)await writeGate;Object.assign(records,clone(values));},
      remove:async keys=>{calls.push(['remove-session',clone(keys)]);for(const key of Array.isArray(keys)?keys:[keys])delete records[key];},
    }},
    tabs:{onRemoved:event(),onUpdated:event()},action:{onClicked:event()},
  };
  Object.defineProperty(api.storage,'local',{get(){throw Error('Disk storage must never be used');}});
  const background=createFormulaBackground(api,()=>1234567);
  return {api,background,records,calls,created};
}

test('accepts explicit bounded raw selections on top-level PDF sources, never an internal frame alone',()=>{
  const record=selectedFormulaRecord(info({frameUrl:'chrome-extension://native-pdf/index.html'}),tab(),100);
  assert.deepEqual(record,{originalUrl:URL,sourceId:'arxiv:1706.03762',rawText:selection,updatedAt:100});
  assert.equal(selectedFormulaRecord(info(),{id:1},100)?.originalUrl,URL);
  assert.equal(selectedFormulaRecord(info(),tab(1,''),100)?.originalUrl,URL);
  assert.equal(selectedFormulaRecord(info({frameUrl:URL}),tab(1,'https://other.test/page'),100),null);
  for(const invalid of [info({selectionText:''}),info({selectionText:' '.repeat(5)}),info({selectionText:'x'.repeat(2001)}),
    info({selectionText:null}),info({editable:true}),info({menuItemId:'other'}),
    info({pageUrl:'https://other.test/page',frameUrl:URL})]) {
    assert.equal(selectedFormulaRecord(invalid,tab(1,'https://other.test/page')),null);
  }
  assert.equal(selectedFormulaRecord(info(),tab(-1)),null);
  assert.equal(selectedFormulaRecord(info({pageUrl:'https://arxiv.org/pdf/2006.11239'}),tab()),null);
});

test('opens the native side panel synchronously in the click gesture before waiting on any storage',async()=>{
  let finish;const opened=new Promise(resolve=>{finish=resolve;});const h=harness({opening:()=>opened});
  const action=h.background.onClick(info(),tab());
  assert.deepEqual(h.calls,[['open',{tabId:1}]]);assert.deepEqual(h.records,{});
  finish();assert.equal(await action,true);
  assert.equal(h.calls[1],'get-session');
  assert.deepEqual(h.records['formula:1'],{originalUrl:URL,sourceId:'arxiv:1706.03762',rawText:selection,updatedAt:1234567});
});

test('rejects unrelated pages before opening or reading session storage',async()=>{
  const h=harness();
  assert.equal(await h.background.onClick(info({pageUrl:'https://other.test/page',frameUrl:URL}),tab(1,'https://other.test/page')),false);
  assert.deepEqual(h.calls,[]);assert.deepEqual(h.records,{});
});

test('stores distinct per-tab records so another tab cannot replace the current tab selection',async()=>{
  const h=harness();
  await Promise.all([h.background.onClick(info(),tab(1)),h.background.onClick(info({selectionText:'unsupported equation'}),tab(2))]);
  assert.equal(h.records['formula:1'].rawText,selection);
  assert.equal(h.records['formula:2'].rawText,'unsupported equation');
  assert.deepEqual(Object.keys(h.records).sort(),['formula:1','formula:2']);
});

test('a delayed old click cannot overwrite a newer selection in the same tab',async()=>{
  let finish,count=0;const delayed=new Promise(resolve=>{finish=resolve;});
  const h=harness({opening:()=>++count===1?delayed:Promise.resolve()});
  const older=h.background.onClick(info(),tab());
  assert.equal(await h.background.onClick(info({selectionText:'new selection'}),tab()),true);
  finish();assert.equal(await older,false);assert.equal(h.records['formula:1'].rawText,'new selection');
});

test('tab closure and navigation remove only that tab context without retaining destination URLs',async()=>{
  const h=harness();await h.background.onClick(info(),tab(1));await h.background.onClick(info(),tab(2));
  await h.api.tabs.onUpdated.emit(1,{url:'https://unrelated.test/private-path'});await h.background.flush();
  assert.equal(h.records['formula:1'],undefined);assert.ok(h.records['formula:2']);
  assert.equal(JSON.stringify(h.calls).includes('private-path'),false);
  await h.api.tabs.onRemoved.emit(2);await h.background.flush();assert.deepEqual(h.records,{});
});

test('a pending write is removed if its tab navigates before the write completes',async()=>{
  let finish;const gate=new Promise(resolve=>{finish=resolve;});const h=harness({writeGate:gate});
  const writing=h.background.onClick(info(),tab());
  for(let count=0;count<10;count++)await Promise.resolve();
  assert.ok(h.calls.some(call=>call[0]==='set-session'));
  await h.api.tabs.onUpdated.emit(1,{status:'loading'});finish();
  assert.equal(await writing,false);await h.background.flush();assert.deepEqual(h.records,{});
});

test('keeps at most twenty memory-only tab records and leaves unrelated extension session keys alone',async()=>{
  const stored={unrelated:'preserved'};
  for(let id=1;id<=21;id++)stored['formula:'+id]={originalUrl:URL,sourceId:'arxiv:1706.03762',rawText:'old',updatedAt:id};
  const h=harness({stored});await h.background.onClick(info(),tab(30));
  assert.equal(Object.keys(h.records).filter(key=>key.startsWith('formula:')).length,20);
  assert.equal(h.records['formula:1'],undefined);assert.equal(h.records['formula:2'],undefined);
  assert.equal(h.records['formula:30'].rawText,selection);assert.equal(h.records.unrelated,'preserved');
});

test('menu registration supports native internal PDF frames while clicks retain strict source checks',async()=>{
  const h=harness();await h.api.runtime.onInstalled.emit();
  assert.equal(h.created.length,1);assert.deepEqual(h.created[0],{id:FORMULA_MENU_ID,title:'Explore formula · Easy ArXiv',contexts:['selection']});
  assert.equal(Object.hasOwn(h.created[0],'documentUrlPatterns'),false);
  assert.equal(h.created[0].title.includes('%s'),false);
});

test('toolbar action only opens instructions and never reads the selected text or stores a URL',async()=>{
  const h=harness();await h.api.action.onClicked.emit(tab(5,'https://other.test/page'));
  assert.deepEqual(h.calls,[['open',{tabId:5}]]);assert.deepEqual(h.records,{});
});

test('an unavailable side panel does not save an unshown selection or mutate the native page',async()=>{
  const h=harness({opening:()=>Promise.reject(Error('panel unavailable'))});
  assert.equal(await h.background.onClick(info(),tab()),false);
  assert.deepEqual(h.records,{});assert.equal(h.calls.length,1);
});


test('general HTTPS PDFs and signed links keep raw case, powers, spacing and source identity', async()=>{
  const h=harness();
  const originalUrl='https://papers.example.test/research/Report.PDF?download=1&signature=Synthetic#page=9';
  const rawText='  E = m*C² + m*c²\n';
  const record=selectedFormulaRecord(info({pageUrl:originalUrl,selectionText:rawText}),tab(7,originalUrl),42);
  assert.deepEqual(record,{originalUrl,sourceId:'pdf:https://papers.example.test/research/Report.PDF',rawText,updatedAt:42});
  assert.equal(await h.background.onClick(info({pageUrl:originalUrl,selectionText:rawText}),tab(7,originalUrl)),true);
  assert.equal(h.records['formula:7'].rawText,rawText);
  assert.equal(h.records['formula:7'].originalUrl,originalUrl);
  assert.equal(h.records['formula:7'].sourceId.includes('signature'),false);
});

test('matching filenames cannot hide a different query document or other PDF source',()=>{
  const first='https://papers.example.test/file.pdf?document=A#page=1';
  const different='https://papers.example.test/file.pdf?document=B#page=1';
  assert.equal(selectedFormulaRecord(info({pageUrl:different}),tab(1,first)),null);
  assert.equal(selectedFormulaRecord(info({pageUrl:'https://another.example.test/file.pdf?document=A'}),tab(1,first)),null);
  assert.ok(selectedFormulaRecord(info({pageUrl:first.replace('#page=1','#page=2')}),tab(1,first)));
  assert.equal(selectedFormulaRecord(info({pageUrl:'file:///synthetic/paper.pdf'}),tab(1,'file:///synthetic/paper.pdf')),null);
});
