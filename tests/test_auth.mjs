import assert from 'node:assert/strict';
import test from 'node:test';
import {makeHarness,exampleUser,paper,plain,Element,flush} from './helpers/core-harness.mjs';
test('anonymous header starts local ORCID login and leaves authenticated links hidden',async()=>{
  const h=makeHarness();await h.api.mountShell();await h.button.emit('click');assert.equal(h.label.textContent,'Continue with ORCID');assert.equal(h.authOnly.hidden,true);assert.equal(h.menu.hidden,true);assert.equal(h.button.getAttribute('aria-controls'),null);assert.deepEqual(h.assigned,['/auth/login']);assert.equal(h.calls.filter(call=>call.url==='/api/session').length,1);assert.equal(h.calls.filter(call=>call.url==='/api/saved').length,0);
});
test('an unconfigured login keeps reading available without claiming guest saves',async()=>{
  const h=makeHarness({configured:false});await h.api.mountShell();await h.button.emit('click');assert.deepEqual(h.assigned,[]);assert.match(h.toast(),/not configured.*Search, reading and audio/);assert.doesNotMatch(h.toast(),/save papers without/);assert.equal(h.document.getElementById('siteToast').getAttribute('role'),'status');
});
test('signed-in menu uses safe text, validated record, saved papers and voice preferences',async()=>{
  const unsafe='<img src=x onerror=alert(1)>';const h=makeHarness({authenticated:true,user:{...exampleUser,name:unsafe}});await h.api.mountShell();assert.equal(h.label.textContent,unsafe);assert.equal(h.name.textContent,unsafe);assert.ok(!h.header.innerHTML.includes(unsafe));assert.equal(h.record.href,'https://orcid.org/'+exampleUser.orcid);assert.equal(h.authOnly.hidden,false);assert.match(h.header.innerHTML,/Saved papers/);assert.match(h.header.innerHTML,/Voice preferences/);await h.button.emit('click');assert.equal(h.menu.hidden,false);assert.equal(h.button.getAttribute('aria-expanded'),'true');await h.button.emit('click');assert.equal(h.menu.hidden,true);
});
test('Escape returns focus and outside click dismisses the account menu',async()=>{
  const h=makeHarness({authenticated:true});await h.api.mountShell();await h.button.emit('click');await h.document.emit('click',{target:h.record});assert.equal(h.menu.hidden,false);await h.document.emit('keydown',{key:'Escape'});assert.equal(h.menu.hidden,true);assert.equal(h.button.focusCount,1);await h.button.emit('click');await h.document.emit('click',{target:new Element()});assert.equal(h.menu.hidden,true);
});
test('logout posts with same-origin credentials, clears account cache and hides account links',async()=>{
  const h=makeHarness({authenticated:true,saved:[paper()]});await h.api.mountShell();assert.equal(h.api.loadSaved().length,1);await h.button.emit('click');await h.signout.emit('click');const request=h.calls.find(call=>call.url==='/auth/logout');assert.equal(request.options.method,'POST');assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.body,undefined);assert.equal(h.api.isAuthenticated(),false);assert.deepEqual(plain(h.api.loadSaved()),[]);assert.equal(h.authOnly.hidden,true);assert.equal(h.menu.hidden,true);assert.match(h.toast(),/signed out/);assert.ok(h.events.some(event=>event.type==='papers:auth' && !event.detail.authenticated));
});
for(const failure of [true,'network'])test(`failed ${failure===true?'HTTP':'network'} logout retains the signed-in account`,async()=>{
  const h=makeHarness({authenticated:true,logoutFailure:failure,saved:[paper()]});await h.api.mountShell();await h.button.emit('click');await h.signout.emit('click');assert.equal(h.api.isAuthenticated(),true);assert.equal(h.menu.hidden,false);assert.equal(h.signout.disabled,false);assert.equal(h.api.loadSaved().length,1);assert.match(h.toast(),/could not be completed/);
});
test('bad identity and session lookup failure cannot unlock account or saved papers',async()=>{
  for(const options of [{authenticated:true,user:{name:'Imposter',orcid:'../../evil.test'}},{sessionFailure:true}]){const h=makeHarness(options);await h.api.mountShell();assert.equal(h.api.isAuthenticated(),false);assert.equal(h.authOnly.hidden,true);assert.deepEqual(plain(h.api.loadSaved()),[]);assert.equal(h.record.href,undefined);await h.button.emit('click');assert.deepEqual(h.assigned,['/auth/login']);}
});
test('auth callback feedback removes only its URL flag',async()=>{
  const h=makeHarness({authenticated:true,location:'http://localhost:5051/papers?q=attention&auth=success#filters'});await h.api.mountShell();assert.match(h.toast(),/Welcome, Ada Researcher/);assert.equal(h.replaced[0][2],'/papers?q=attention#filters');const cancelled=makeHarness({location:'http://localhost:5051/?auth=cancelled'});await cancelled.api.mountShell();assert.match(cancelled.toast(),/cancelled/);const missing=makeHarness({location:'http://localhost:5051/?auth=success'});await missing.api.mountShell();assert.match(missing.toast(),/session could not be confirmed/);
});
test('guest saving waits for session then opens a sign-in dialog without sending a save request',async()=>{
  let finish;const gate=new Promise(resolve=>{finish=resolve;});const h=makeHarness({sessionGate:gate});const action=h.api.toggleSaved(paper());await flush();assert.equal(h.document.getElementById('signInDialog'),null);finish();assert.equal(await action,false);const dialog=h.document.getElementById('signInDialog');assert.equal(dialog.open,true);assert.equal(dialog.getAttribute('aria-labelledby'),'signInTitle');assert.match(dialog.querySelector('#signInReason').textContent,/Sign in to save/);assert.equal(h.calls.some(call=>call.options.method==='POST'),false);assert.deepEqual(h.localStorage.writes,[]);
});
test('a save clicked during pending authentication succeeds for the verified account',async()=>{
  let finish;const gate=new Promise(resolve=>{finish=resolve;});const h=makeHarness({authenticated:true,sessionGate:gate});const action=h.api.toggleSaved(paper());await flush();assert.equal(h.calls.some(call=>call.options.method==='POST'),false);finish();assert.equal(await action,true);assert.equal(h.api.isSaved('1706.03762'),true);assert.equal(h.document.getElementById('signInDialog'),null);
});
test('server account saves are normalized, deduplicated, isolated from browser legacy bookmarks and removable by canonical ID',async()=>{
  const h=makeHarness({authenticated:true,saved:[paper(),paper({id:'1706.03762v7',title:'Version seven'}),null,{id:'evil'}]});await h.api.authReady;const items=plain(h.api.loadSaved());assert.equal(items.length,1);assert.equal(items[0].title,'Version seven');items[0].authors.push('Mutation');assert.equal(h.api.loadSaved()[0].authors.length,1);assert.equal(h.api.isSaved('1706.03762v7'),true);assert.equal(await h.api.toggleSaved(paper()),false);assert.equal(h.api.isSaved('1706.03762'),false);assert.equal(h.calls.find(call=>call.options.method==='DELETE').url,'/api/saved/1706.03762');assert.deepEqual(h.localStorage.writes,[]);
});
test('concurrent bookmark clicks produce one server mutation and failed writes retain cache',async()=>{
  const h=makeHarness({authenticated:true});await h.api.authReady;const result=await Promise.all([h.api.toggleSaved(paper()),h.api.toggleSaved(paper())]);assert.deepEqual(result,[true,true]);assert.equal(h.calls.filter(call=>call.options.method==='POST').length,1);const failed=makeHarness({authenticated:true,saved:[paper()],saveFailure:500});await failed.api.authReady;assert.equal(await failed.api.toggleSaved(paper()),true);assert.equal(failed.api.isSaved('1706.03762'),true);assert.match(failed.toast(),/could not be removed/);
});
test('expired server session clears cache and requests sign-in',async()=>{
  const h=makeHarness({authenticated:true,saved:[paper()],saveFailure:401});await h.api.mountShell();assert.equal(await h.api.toggleSaved(paper()),false);assert.equal(h.api.isAuthenticated(),false);assert.deepEqual(plain(h.api.loadSaved()),[]);assert.equal(h.authOnly.hidden,true);assert.equal(h.document.getElementById('signInDialog').open,true);assert.match(h.document.getElementById('signInDialog').querySelector('#signInReason').textContent,/session expired/);
});
test('provider credentials are never copied to browser storage or saved API payloads',async()=>{
  const secret='SYNTHETIC-TEST-TOKEN';const h=makeHarness({authenticated:true,user:{...exampleUser,access_token:secret,refresh_token:secret}});await h.api.mountShell();await h.api.toggleSaved(paper());await h.signout.emit('click');assert.deepEqual(h.localStorage.writes,[]);assert.deepEqual(h.sessionStorage.writes,[]);assert.ok(!h.header.innerHTML.includes(secret));assert.ok(!JSON.stringify(h.calls).includes(secret));
});
test('footer replaces X with the user-approved Product Hunt product link',async()=>{
  const h=makeHarness();await h.api.mountShell();assert.match(h.footer.innerHTML,/https:\/\/www\.producthunt\.com\/products\/easy-arxiv/);assert.match(h.footer.innerHTML,/Easy ArXiv on Product Hunt/);assert.doesNotMatch(h.footer.innerHTML,/x\.com|twitter\.com/);
});

const savedResponse = (payload, status=200) => ({ok:status>=200 && status<300,status,json:async()=>payload});
const savedBatch = (start, count=20) => Array.from({length:count},(_,index)=>paper({id:'1706.'+String(start+index).padStart(5,'0'),title:'Saved paper '+(start+index)}));
const savedGets = h => h.calls.filter(call=>call.url.startsWith('/api/saved') && !call.options.method);

test('paginated saved papers appear together only after the complete list arrives',async()=>{
  let finish;const secondPage=new Promise(resolve=>{finish=resolve;});
  const h=makeHarness({authenticated:true,getSavedResponse:async({url})=>{
    if(url==='/api/saved')return savedResponse({papers:savedBatch(0),has_more:true,next_start:20});
    assert.equal(url,'/api/saved?start=20');await secondPage;
    return savedResponse({papers:savedBatch(20,1),has_more:false,next_start:null});
  }});
  await flush();
  assert.equal(savedGets(h).length,2);assert.deepEqual(plain(h.api.loadSaved()),[]);
  assert.equal(h.events.filter(event=>event.type==='papers:saved').length,0);
  finish();await h.api.authReady;
  assert.equal(h.api.loadSaved().length,21);
  assert.equal(h.api.loadSaved()[20].title,'Saved paper 20');
  assert.equal(h.events.filter(event=>event.type==='papers:saved').length,1);
  assert.ok(savedGets(h).every(call=>call.options.credentials==='same-origin'));
});

test('all one hundred saved papers load in at most five requests and legacy lists stay one page',async()=>{
  const h=makeHarness({authenticated:true,getSavedResponse:({url})=>{
    const start=Number(new URL(url,'https://example.test').searchParams.get('start')||0);
    return savedResponse({papers:savedBatch(start),has_more:start<80,next_start:start<80?start+20:null});
  }});
  await h.api.authReady;assert.equal(h.api.loadSaved().length,100);
  assert.deepEqual(savedGets(h).map(call=>call.url),['/api/saved','/api/saved?start=20','/api/saved?start=40','/api/saved?start=60','/api/saved?start=80']);
  const legacy=makeHarness({authenticated:true,saved:savedBatch(0,25)});
  await legacy.api.authReady;assert.equal(legacy.api.loadSaved().length,25);assert.equal(savedGets(legacy).length,1);
});

test('a failed later page keeps the previous complete saved list and reports the failed refresh',async()=>{
  let refreshing=false;
  const h=makeHarness({authenticated:true,getSavedResponse:({url})=>{
    if(!refreshing)return savedResponse({papers:[paper()]});
    return url==='/api/saved'?savedResponse({papers:savedBatch(0),has_more:true,next_start:20}):savedResponse({},503);
  }});
  await h.api.authReady;const before=plain(h.api.loadSaved());const events=h.events.filter(event=>event.type==='papers:saved').length;
  refreshing=true;const result=await h.api.refreshSaved();
  assert.deepEqual(plain(result),before);assert.deepEqual(plain(h.api.loadSaved()),before);
  assert.equal(h.events.filter(event=>event.type==='papers:saved').length,events);
  assert.match(h.toast(),/saved papers could not be loaded/);assert.equal(h.api.isAuthenticated(),true);
});

test('malformed pagination cannot loop, overfill, or publish a partial saved list',async()=>{
  for(const next_start of [0,-1,0.5,NaN,Infinity,'20',101,undefined]){
    const h=makeHarness({authenticated:true,getSavedResponse:()=>savedResponse({papers:savedBatch(0),has_more:true,next_start})});
    await h.api.authReady;assert.equal(savedGets(h).length,1);assert.deepEqual(plain(h.api.loadSaved()),[]);
    assert.equal(h.events.some(event=>event.type==='papers:saved'),false);
  }
  for(const payload of [{papers:savedBatch(0,101)},{papers:savedBatch(0),has_more:'false'},{papers:null,has_more:false}]){
    const h=makeHarness({authenticated:true,getSavedResponse:()=>savedResponse(payload)});
    await h.api.authReady;assert.equal(savedGets(h).length,1);assert.deepEqual(plain(h.api.loadSaved()),[]);
  }
  let count=0;
  const repeating=makeHarness({authenticated:true,getSavedResponse:()=>savedResponse({papers:savedBatch(count++,1),has_more:true,next_start:20})});
  await repeating.api.authReady;assert.equal(savedGets(repeating).length,2);assert.deepEqual(plain(repeating.api.loadSaved()),[]);
  count=0;
  const endless=makeHarness({authenticated:true,getSavedResponse:()=>savedResponse({papers:savedBatch(count,1),has_more:true,next_start:++count})});
  await endless.api.authReady;assert.equal(savedGets(endless).length,5);assert.deepEqual(plain(endless.api.loadSaved()),[]);
});

test('an expired session on a later page clears account data and hides authenticated links',async()=>{
  const h=makeHarness({authenticated:true,getSavedResponse:({url})=>url==='/api/saved'?
    savedResponse({papers:savedBatch(0),has_more:true,next_start:20}):savedResponse({},401)});
  await h.api.mountShell();assert.equal(savedGets(h).length,2);
  assert.equal(h.api.isAuthenticated(),false);assert.deepEqual(plain(h.api.loadSaved()),[]);assert.equal(h.authOnly.hidden,true);
});

test('logout while a later saved page is pending prevents that response restoring the old account cache',async()=>{
  let refreshing=false,finish;const laterPage=new Promise(resolve=>{finish=resolve;});
  const h=makeHarness({authenticated:true,getSavedResponse:async({url})=>{
    if(!refreshing)return savedResponse({papers:[paper()]});
    if(url==='/api/saved')return savedResponse({papers:savedBatch(0),has_more:true,next_start:20});
    await laterPage;return savedResponse({papers:savedBatch(20,1),has_more:false,next_start:null});
  }});
  await h.api.mountShell();refreshing=true;const refresh=h.api.refreshSaved();await flush();
  assert.equal(savedGets(h).length,3);await h.signout.emit('click');finish();await refresh;
  assert.equal(h.api.isAuthenticated(),false);assert.deepEqual(plain(h.api.loadSaved()),[]);
  assert.equal(h.events.filter(event=>event.type==='papers:saved').at(-1).detail.papers.length,0);
});

test('the server reading-list cap tells the user to remove a paper and keeps the existing collection',async()=>{
  const h=makeHarness({authenticated:true,saved:savedBatch(0,100),saveFailure:409});
  await h.api.authReady;assert.equal(await h.api.toggleSaved(paper({id:'2401.12345'})),false);
  assert.equal(h.api.loadSaved().length,100);assert.equal(h.api.isAuthenticated(),true);
  assert.match(h.toast(),/full \(100 papers\).*Remove a paper/);
});
