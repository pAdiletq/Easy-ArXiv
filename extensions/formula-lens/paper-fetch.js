import {pdfSource} from './selection.js';
export const MAX_PDF_BYTES=6*1024*1024;

export async function currentPaper(api=globalThis.chrome){
  const tab=(await api.tabs.query({active:true,currentWindow:true}))[0];
  const source=pdfSource(tab?.url);
  if(!Number.isSafeInteger(tab?.id)||!source)throw new Error('Open a PDF over HTTPS, then open Formula Lens from the toolbar or a selected formula.');
  return {tabId:tab.id,source};
}
function encodeBase64(bytes){let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(binary);}
export async function readSelectedPaper(expectedSourceId,{api=globalThis.chrome,fetcher=globalThis.fetch,signal,expectedOriginalURL,expectedTabId}={}){
  if(signal?.aborted)throw new Error('PDF download was cancelled.');
  const {tabId,source}=await currentPaper(api);
  if(typeof expectedSourceId!=='string'||expectedSourceId!==source.sourceId)throw new Error('The selected paper changed. Open its PDF and try again.');
  if((expectedOriginalURL!==undefined&&expectedOriginalURL!==source.originalUrl)||(expectedTabId!==undefined&&expectedTabId!==tabId))throw new Error('The original paper tab changed. Return to the selected PDF and try again.');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  const changed=(id,change)=>{if(id===tabId&&(typeof change.url==='string'||change.status==='loading'))controller.abort();};
  const removed=id=>{if(id===tabId)controller.abort();};api.tabs.onUpdated?.addListener(changed);api.tabs.onRemoved?.addListener(removed);
  try{
    const response=await fetcher(source.originalUrl,{credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal});
    if(!response.ok){await response.body?.cancel();throw new Error('The original PDF could not be downloaded.');}
    if(Number(response.headers.get('content-length'))>MAX_PDF_BYTES){await response.body?.cancel();throw new Error('This PDF exceeds the 6 MB analysis limit. The document will not be truncated.');}
    const chunks=[];let length=0;
    if(!response.body?.getReader)throw new Error('The PDF response cannot be read safely.');
    const reader=response.body.getReader();
    try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>MAX_PDF_BYTES){await reader.cancel();throw new Error('This PDF exceeds the 6 MB analysis limit. The document will not be truncated.');}chunks.push(part.value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const header=new TextDecoder('latin1').decode(bytes.subarray(0,1024));if(!header.includes('%PDF-'))throw new Error('The selected address did not return a PDF document.');
    const latest=(await api.tabs.get(tabId));if(latest?.url!==source.originalUrl||controller.signal.aborted)throw new Error('The paper tab changed during download.');
    return {pdfBase64:encodeBase64(bytes),source:{sourceId:source.sourceId,label:source.label}};
  }catch(error){if(controller.signal.aborted)throw new Error('PDF download was cancelled or took too long.');throw error;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);api.tabs.onUpdated?.removeListener(changed);api.tabs.onRemoved?.removeListener(removed);}
}
export function registerPaperMessages(api=globalThis.chrome){
  if(!api?.runtime?.onMessage)return;
  api.runtime.onMessage.addListener((message,sender,reply)=>{
    if(sender.id!==api.runtime.id||sender.url?.split(/[?#]/)[0]!==api.runtime.getURL('sidepanel.html'))return false;
    if(message?.type!=='formula/paper-source'&&message?.type!=='formula/read-paper')return false;
    const job=message.type==='formula/paper-source'?currentPaper(api):readSelectedPaper(message.sourceId,{api,expectedOriginalURL:message.expectedOriginalURL,expectedTabId:message.expectedTabId});
    Promise.resolve(job).then(data=>reply({ok:true,data}),error=>reply({ok:false,error:typeof error?.message==='string'?error.message:'The paper could not be read.'}));return true;
  });
}
