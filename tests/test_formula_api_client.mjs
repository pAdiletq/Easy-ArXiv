import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'node:test';
import {APP_ORIGIN, CONNECTION_KEY, createPairProof, formulaRequest, existingConnection, connectFormulaService, disconnectFormulaService} from '../extensions/formula-lens/api-client.js';

const EXTENSION_ID = 'a'.repeat(32);
const NOW = 1_700_000_000_000;
const GRANT = 'synthetic-session-grant-for-tests';
const encode = value => new TextEncoder().encode(value);
const reply = (data, status = 200) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json'}});
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const grant = (changes = {}) => ({accessToken:GRANT, expiresAt:NOW + 20*60*1000, extensionId:EXTENSION_ID, ...changes});

function chromeFixture(initial = {}) {
  const records = {...initial}, calls = {get:[], set:[], remove:[], create:[], update:[]};
  const forbidden = () => {throw new Error('Persistent storage must not be used.');};
  const api = {
    runtime:{id:EXTENSION_ID},
    storage:{
      session:{
        async get(key) {calls.get.push(key); return {[key]:records[key]};},
        async set(values) {calls.set.push(values); Object.assign(records, values);},
        async remove(key) {calls.remove.push(key); delete records[key];}
      },
      local:{get:forbidden, set:forbidden, remove:forbidden},
      sync:{get:forbidden, set:forbidden, remove:forbidden}
    },
    tabs:{
      async query(query) {assert.deepEqual(query,{active:true,currentWindow:true}); return [{id:42}];},
      async create(value) {calls.create.push(value); return {id:99};},
      async update(id, value) {calls.update.push({id,...value});}
    }
  };
  return {api, records, calls};
}

function streamReply(chunks, {status = 200, headers = {}} = {}) {
  let index = 0, cancelled = false;
  const body = new ReadableStream({
    pull(controller) {if(index < chunks.length) controller.enqueue(chunks[index++]); else controller.close();},
    cancel() {cancelled = true;}
  });
  return {response:new Response(body,{status,headers}), cancelled:() => cancelled};
}

function pairingFetcher(replies, calls = []) {
  return async (url, options) => {
    calls.push({url,options});
    assert.equal(new URL(url).origin,APP_ORIGIN);
    assert.equal(options.credentials,'omit');
    assert.equal(options.redirect,'error');
    const path = new URL(url).pathname;
    if(path === '/api/extension/pair/start') return reply({pairId:'synthetic-pair',authorizeUrl:APP_ORIGIN+'/extension-connect?pair=synthetic-pair'});
    assert.equal(path,'/api/extension/pair/token');
    assert.ok(replies.length,'Unexpected additional approval poll');
    const item = replies.shift(); return reply(item.body,item.status);
  };
}

test('pair proof is fresh base64url randomness with the exact SHA-256 PKCE challenge', async () => {
  const a = await createPairProof(), b = await createPairProof();
  for(const proof of [a,b]) {
    assert.match(proof.verifier,/^[A-Za-z0-9_-]{43}$/);
    assert.match(proof.challenge,/^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(proof.verifier,'base64url').byteLength,32);
    assert.equal(proof.challenge,createHash('sha256').update(proof.verifier).digest('base64url'));
  }
  assert.notEqual(a.verifier,b.verifier);
  assert.notEqual(a.challenge,b.challenge);
});

test('only fixed main-site extension routes are accepted, with no fetch for arbitrary addresses', async () => {
  assert.equal(APP_ORIGIN,'https://easy-arxiv.pages.dev');
  const calls=[];
  const fetcher=async(url,options)=>{calls.push({url,options});return reply({ok:true});};
  for(const path of ['/api/extension/pair/start','/api/extension/pair/token','/api/extension/papers','/api/extension/explain','/api/extension/revoke']) {
    await formulaRequest(path,{example:'synthetic'},{fetcher});
    assert.equal(calls.at(-1).url,APP_ORIGIN+path);
  }
  const count=calls.length;
  for(const path of ['https://example.invalid/api/extension/papers','//example.invalid/api/extension/papers','/api/extension/papers?redirect=external','/api/extension/../papers','/auth/logout','/api/extension/unknown']) {
    await assert.rejects(formulaRequest(path,{}, {fetcher}),/not supported/);
  }
  assert.equal(calls.length,count);
});

test('API posts omit browser credentials, reject redirects and use only the explicit bearer grant', async () => {
  const abort=new AbortController(); let observed;
  const result=await formulaRequest('/api/extension/explain',{formula:'x^2'},{accessToken:GRANT,signal:abort.signal,fetcher:async(url,options)=>{observed={url,options};return reply({answer:'synthetic'});}});
  assert.deepEqual(result,{status:200,data:{answer:'synthetic'}});
  assert.equal(observed.options.method,'POST');
  assert.equal(observed.options.credentials,'omit');
  assert.equal(observed.options.redirect,'error');
  assert.equal(observed.options.signal,abort.signal);
  assert.deepEqual(observed.options.headers,{'Content-Type':'application/json',Authorization:'Bearer '+GRANT});
  assert.deepEqual(JSON.parse(observed.options.body),{formula:'x^2'});
  await formulaRequest('/api/extension/pair/start',{}, {fetcher:async(url,options)=>{assert.equal(Object.hasOwn(options.headers,'Authorization'),false);return reply({});}});
});

test('bounded UTF-8 decoding handles a multibyte character split across streamed chunks', async () => {
  const bytes=encode(JSON.stringify({detail:'Delta: Δx; alpha: α'}));
  const streamed=streamReply(Array.from(bytes,byte=>Uint8Array.of(byte)));
  const result=await formulaRequest('/api/extension/papers',{}, {fetcher:async()=>streamed.response});
  assert.equal(result.data.detail,'Delta: Δx; alpha: α');
});

test('a declared oversize response is cancelled before body reading', async () => {
  const streamed=streamReply([encode('{}')],{headers:{'Content-Length':'256001'}});
  await assert.rejects(formulaRequest('/api/extension/papers',{}, {fetcher:async()=>streamed.response}),/too large/);
  assert.equal(streamed.cancelled(),true);
});

test('an undeclared oversize stream is cancelled at the actual byte limit', async () => {
  const streamed=streamReply([new Uint8Array(128001),new Uint8Array(128001),new Uint8Array(16)]);
  await assert.rejects(formulaRequest('/api/extension/papers',{}, {fetcher:async()=>streamed.response}),/too large/);
  assert.equal(streamed.cancelled(),true);
  assert.equal(streamed.response.body.locked,false);
});

test('malformed JSON, invalid UTF-8 and empty responses cannot become successful analysis data', async () => {
  await assert.rejects(formulaRequest('/api/extension/papers',{}, {fetcher:async()=>new Response('<html>Unavailable</html>')}),/not available yet/);
  await assert.rejects(formulaRequest('/api/extension/papers',{}, {fetcher:async()=>new Response(Uint8Array.of(255))}));
  await assert.rejects(formulaRequest('/api/extension/papers',{}, {fetcher:async()=>new Response(null)}),/empty/);
});

test('HTTP errors preserve their status and bound server-provided detail', async () => {
  await assert.rejects(formulaRequest('/api/extension/explain',{}, {fetcher:async()=>reply({detail:'x'.repeat(800)},429)}),error=>{
    assert.equal(error.status,429);assert.equal(error.message.length,500);return true;
  });
});

test('cached connection uses session storage and validates scope, lifetime and grant size', async () => {
  const valid=grant(), fixture=chromeFixture({[CONNECTION_KEY]:valid});
  assert.deepEqual(await existingConnection(fixture.api,()=>NOW),valid);
  assert.deepEqual(fixture.calls.get,[CONNECTION_KEY]);
  const invalid=[null,{},grant({accessToken:'test-short'}),grant({accessToken:'test-'.repeat(52)}),grant({expiresAt:NOW}),grant({expiresAt:NOW+5000}),grant({expiresAt:NOW+30*60*1000+1}),grant({expiresAt:Infinity}),grant({expiresAt:String(NOW+60000)}),grant({extensionId:'b'.repeat(32)})];
  for(const value of invalid) {
    const current=chromeFixture({[CONNECTION_KEY]:value});
    assert.equal(await existingConnection(current.api,()=>NOW),null);
    assert.deepEqual(current.calls.set,[]);
  }
  assert.equal(await existingConnection({},()=>NOW),null);
});

test('an unexpired cached connection avoids pairing, tab creation and network access', async () => {
  const fixture=chromeFixture({[CONNECTION_KEY]:grant()});
  const connected=await connectFormulaService({api:fixture.api,now:()=>NOW,fetcher:()=>{throw new Error('Network must not run.');}});
  assert.deepEqual(connected,grant());assert.deepEqual(fixture.calls.create,[]);assert.deepEqual(fixture.calls.set,[]);
});

test('preview or invalid extension IDs cannot start pairing', async () => {
  for(const id of ['', 'invalid', 'z'.repeat(32)]) {
    const fixture=chromeFixture();fixture.api.runtime.id=id;
    await assert.rejects(connectFormulaService({api:fixture.api,now:()=>NOW,fetcher:()=>{throw new Error('No network from preview.');}}),/Install the extension/);
    assert.deepEqual(fixture.calls.create,[]);assert.deepEqual(fixture.calls.set,[]);
  }
});

test('authorization must stay on the fixed main-site origin and exact pairing page', async () => {
  for(const authorizeUrl of ['https://example.invalid/extension-connect',APP_ORIGIN+'/different-page','http://easy-arxiv.pages.dev/extension-connect',APP_ORIGIN+'/extension-connect/']) {
    const fixture=chromeFixture();
    await assert.rejects(connectFormulaService({api:fixture.api,now:()=>NOW,fetcher:async()=>reply({pairId:'synthetic-pair',authorizeUrl})}),/not trusted/);
    assert.deepEqual(fixture.calls.create,[]);assert.deepEqual(fixture.calls.set,[]);
  }
});

test('approval polling waits through 202, proves the challenge and stores only a scoped session grant', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const fixture=chromeFixture(), opened=deferred(), calls=[], statuses=[];
  const fetcher=pairingFetcher([{status:202,body:{pending:true}},{status:200,body:{accessToken:GRANT,expiresAt:NOW+20*60*1000}}],calls);
  const pending=connectFormulaService({api:fixture.api,now:()=>NOW,fetcher,onStatus:message=>{statuses.push(message);opened.resolve();}});
  await opened.promise;
  assert.deepEqual(fixture.calls.create,[{url:APP_ORIGIN+'/extension-connect?pair=synthetic-pair'}]);
  assert.equal(calls.length,1);
  t.mock.timers.tick(2000);await nextTurn();
  assert.equal(calls.length,2);assert.deepEqual(fixture.calls.set,[]);
  t.mock.timers.tick(2000);
  const connected=await pending;
  assert.deepEqual(connected,grant());assert.equal(calls.length,3);
  const start=JSON.parse(calls[0].options.body), poll=JSON.parse(calls[1].options.body);
  assert.deepEqual(Object.keys(start).sort(),['challenge','extensionId']);
  assert.equal(start.extensionId,EXTENSION_ID);
  assert.equal(poll.pairId,'synthetic-pair');
  assert.equal(start.challenge,createHash('sha256').update(poll.verifier).digest('base64url'));
  assert.deepEqual(JSON.parse(calls[2].options.body),poll);
  assert.deepEqual(fixture.calls.set,[{[CONNECTION_KEY]:grant()}]);
  assert.deepEqual(fixture.calls.update,[{id:42,active:true}]);assert.equal(statuses.length,2);
});

test('invalid fresh grants are rejected without creating session credentials', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  for(const body of [{accessToken:'test-short',expiresAt:NOW+60000},{accessToken:'test-'.repeat(52),expiresAt:NOW+60000},{accessToken:GRANT,expiresAt:NOW},{accessToken:GRANT,expiresAt:NOW+30*60*1000+1},{accessToken:GRANT,expiresAt:'later'}]) {
    const fixture=chromeFixture(), opened=deferred();
    const pending=connectFormulaService({api:fixture.api,now:()=>NOW,fetcher:pairingFetcher([{status:200,body}]),onStatus:()=>opened.resolve()});
    const rejected=assert.rejects(pending,/invalid connection grant/);
    await opened.promise;t.mock.timers.tick(2000);await rejected;
    assert.deepEqual(fixture.calls.set,[]);
  }
});

test('aborting while approval is pending stops polling and does not save a grant', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const fixture=chromeFixture(), opened=deferred(), controller=new AbortController(), calls=[];
  const pending=connectFormulaService({api:fixture.api,now:()=>NOW,signal:controller.signal,fetcher:pairingFetcher([],calls),onStatus:()=>opened.resolve()});
  const rejected=assert.rejects(pending,/cancelled/);
  await opened.promise;controller.abort();await rejected;
  t.mock.timers.tick(600000);assert.equal(calls.length,1);assert.deepEqual(fixture.calls.set,[]);
});

test('approval has a finite five-minute deadline even when the server keeps returning 202', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const fixture=chromeFixture(), opened=deferred();let clock=NOW,polls=0;
  const fetcher=async url=>{
    if(url.endsWith('/pair/start'))return reply({pairId:'synthetic-pair',authorizeUrl:APP_ORIGIN+'/extension-connect'});
    polls++;clock=NOW+5*60*1000;return reply({pending:true},202);
  };
  const pending=connectFormulaService({api:fixture.api,now:()=>clock,fetcher,onStatus:()=>opened.resolve()});
  const rejected=assert.rejects(pending,/timed out/);
  await opened.promise;t.mock.timers.tick(2000);await rejected;
  assert.equal(polls,1);assert.deepEqual(fixture.calls.set,[]);
});

test('disconnect removes only the session grant and retains unrelated per-tab selections', async () => {
  const fixture=chromeFixture({[CONNECTION_KEY]:grant(),'formula:42':{text:'synthetic selection'}});
  await disconnectFormulaService(fixture.api);
  assert.deepEqual(fixture.calls.remove,[CONNECTION_KEY]);
  assert.equal(fixture.records[CONNECTION_KEY],undefined);
  assert.deepEqual(fixture.records['formula:42'],{text:'synthetic selection'});
});
