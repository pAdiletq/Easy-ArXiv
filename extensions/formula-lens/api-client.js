export const APP_ORIGIN='https://easy-arxiv.pages.dev';
export const CONNECTION_KEY='formula-connection';
const ROUTES=new Set(['/api/extension/pair/start','/api/extension/pair/token','/api/extension/papers','/api/extension/explain','/api/extension/revoke']);

export async function formulaRequest(path,body,{accessToken='',signal,fetcher=globalThis.fetch}={}){
  if(!ROUTES.has(path))throw new Error('This service route is not supported.');
  const headers={'Content-Type':'application/json'};
  if(accessToken)headers.Authorization=`Bearer ${accessToken}`;
  const response=await fetcher(APP_ORIGIN+path,{method:'POST',headers,body:JSON.stringify(body),credentials:'omit',redirect:'error',signal});
  const declared=Number(response.headers.get('content-length'));
  if(declared>256000){await response.body?.cancel();throw new Error('The analysis response is too large.');}
  const reader=response.body?.getReader();if(!reader)throw new Error('The analysis response is empty.');
  let text='',length=0;const decoder=new TextDecoder('utf-8',{fatal:true});
  try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>256000){await reader.cancel();throw new Error('The analysis response is too large.');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
  let data;try{data=JSON.parse(text);}catch{throw new Error('The analysis service is not available yet.');}
  if(!response.ok){const error=new Error(typeof data.detail==='string'?data.detail.slice(0,500):'The request could not be completed.');error.status=response.status;throw error;}
  return {status:response.status,data};
}
const base64url=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
export async function createPairProof(cryptoAPI=globalThis.crypto){
  const verifier=base64url(cryptoAPI.getRandomValues(new Uint8Array(32)));
  const challenge=base64url(new Uint8Array(await cryptoAPI.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
  return {verifier,challenge};
}
function sleep(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted){reject(new Error('Connection cancelled.'));return;}const aborted=()=>{clearTimeout(timer);reject(new Error('Connection cancelled.'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',aborted);resolve();},ms);signal?.addEventListener('abort',aborted,{once:true});});}
export async function existingConnection(api=globalThis.chrome,now=Date.now){
  if(!api?.runtime?.id||!api.storage?.session)return null;
  const data=await api.storage.session.get(CONNECTION_KEY),record=data[CONNECTION_KEY];
  if(typeof record?.accessToken!=='string'||record.accessToken.length<20||record.accessToken.length>256||!Number.isFinite(record.expiresAt)||record.expiresAt<=now()+5000||record.expiresAt>now()+30*60*1000||record.extensionId!==api.runtime.id)return null;
  return record;
}
export async function connectFormulaService({api=globalThis.chrome,signal,onStatus=()=>{},fetcher=globalThis.fetch,now=Date.now}={}){
  if(!/^[a-p]{32}$/.test(api?.runtime?.id||''))throw new Error('Install the extension to connect. This interface preview does not contact the AI service.');
  const existing=await existingConnection(api,now);if(existing)return existing;
  const proof=await createPairProof();
  const start=await formulaRequest('/api/extension/pair/start',{extensionId:api.runtime.id,challenge:proof.challenge},{signal,fetcher});
  if(typeof start.data.pairId!=='string'||typeof start.data.authorizeUrl!=='string')throw new Error('The connection service returned an invalid response.');
  const authorize=new URL(start.data.authorizeUrl);
  if(authorize.origin!==APP_ORIGIN||authorize.pathname!=='/extension-connect')throw new Error('The connection address is not trusted.');
  const previous=(await api.tabs.query({active:true,currentWindow:true}))[0]?.id;
  await api.tabs.create({url:authorize.href});onStatus('Sign in and approve Formula Lens in the Easy ArXiv tab.');
  const deadline=now()+5*60*1000;
  while(now()<deadline){
    await sleep(2000,signal);
    const reply=await formulaRequest('/api/extension/pair/token',{pairId:start.data.pairId,verifier:proof.verifier},{signal,fetcher});
    if(reply.status===202)continue;
    const {accessToken,expiresAt}=reply.data;
    if(typeof accessToken!=='string'||accessToken.length<20||accessToken.length>256||!Number.isFinite(expiresAt)||expiresAt<=now()||expiresAt>now()+30*60*1000)throw new Error('The service returned an invalid connection grant.');
    const connection={accessToken,expiresAt,extensionId:api.runtime.id};await api.storage.session.set({[CONNECTION_KEY]:connection});
    if(Number.isSafeInteger(previous))try{await api.tabs.update(previous,{active:true});}catch{/* The paper tab may have been closed. */}
    onStatus('Connected. Return to the paper to continue.');return connection;
  }
  throw new Error('Connection approval timed out. Try connecting again.');
}
export async function disconnectFormulaService(api=globalThis.chrome){await api?.storage?.session?.remove(CONNECTION_KEY);}
