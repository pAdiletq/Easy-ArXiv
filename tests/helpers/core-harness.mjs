import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../static/js/core.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export \{.*\};?\r?\n/gm,'').replace(/^export /gm,'');
export const exampleUser={name:'Ada Researcher',orcid:'0000-0002-1825-0097'};
export const paper=(overrides={})=>({id:'1706.03762',title:'Attention Is All You Need',authors:['Ashish Vaswani'],summary:'Attention connects positions.',published:'2017-06-12',...overrides});
export const plain=value=>JSON.parse(JSON.stringify(value));
export const flush=async()=>{for(let i=0;i<14;i++)await Promise.resolve();};
export class Element {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.attributes=new Map();this.listeners=new Map();this.children=[];this.hidden=false;this.disabled=false;this.textContent='';this.innerHTML='';this.focusCount=0;this.selectors=new Map();this.isConnected=true;const classes=new Set();this.classList={toggle:(name,force)=>{if(force??!classes.has(name))classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)};}
  setAttribute(name,value){this.attributes.set(name,String(value));if(name==='open')this.open=true;}
  getAttribute(name){return this.attributes.get(name)??null;}
  removeAttribute(name){this.attributes.delete(name);if(name==='open')this.open=false;}
  addEventListener(name,fn){this.listeners.set(name,[...(this.listeners.get(name)||[]),fn]);}
  async emit(name,props={}){const event={target:this,currentTarget:this,preventDefault(){},...props};for(const callback of this.listeners.get(name)||[])await callback(event);await flush();}
  querySelector(selector){if(!this.selectors.has(selector)){const el=new Element(selector.includes('button')?'button':'div');this.selectors.set(selector,el);this.append(el);}return this.selectors.get(selector);}
  querySelectorAll(selector){return this.allSelectors?.get(selector)||[];}
  append(element){this.children.push(element);}
  replaceChildren(...elements){this.children=elements;}
  contains(element){return element===this || this.children.some(child=>child.contains(element));}
  focus(){this.focusCount++;}
  showModal(){this.open=true;}
  close(){this.open=false;}
}
function storage(initial={}){const values=new Map(Object.entries(initial));const writes=[];return{values,writes,getItem:key=>values.get(key)??null,setItem(key,value){writes.push([key,String(value)]);values.set(key,String(value));}};}
export function makeHarness({authenticated=false,user=exampleUser,configured=true,sessionFailure=false,logoutFailure=false,saveFailure=false,getSavedFailure=false,getSavedResponse=null,sessionGate=null,saved=[],location='http://localhost:5051/papers?q=attention'}={}){
  const header=new Element();const footer=new Element();const body=new Element('body');const head=new Element('head');const document=new Element('document');document.body=body;document.head=head;
  const authOnly=new Element('a');document.allSelectors=new Map([['[data-auth-only]',[authOnly]]]);
  document.querySelector=selector=>({'[data-site-header]':header,'[data-site-footer]':footer}[selector]||null);
  document.getElementById=id=>[...body.children,...head.children].find(el=>el.id===id)||null;document.createElement=tag=>new Element(tag);
  const button=header.querySelector('[data-orcid]'),menu=header.querySelector('.account-menu');menu.hidden=true;
  const label=header.querySelector('[data-account-label]'),name=header.querySelector('[data-account-name]'),record=header.querySelector('[data-orcid-record]'),signout=header.querySelector('[data-signout]');menu.append(record);menu.append(signout);
  const assigned=[],replaced=[],calls=[],events=[];const current=new URL(location);const window=new Element('window');
  window.location={href:current.href,search:current.search,assign:value=>assigned.push(value)};window.history={replaceState:(...args)=>replaced.push(args)};
  window.dispatchEvent=event=>{events.push(event);for(const callback of window.listeners.get(event.type)||[])callback(event);return true;};
  const localStorage=storage({'easy-arxiv-web:saved:v1':JSON.stringify([paper({id:'2006.11239'})]),'existing-papers':'unchanged'}),sessionStorage=storage({'existing-selection':'unchanged'});
  let serverPapers=saved.slice();let signedIn=authenticated;
  const fetch=async(url,options={})=>{
    calls.push({url,options});
    if(url==='/api/session'){if(sessionGate)await sessionGate;if(sessionFailure)throw new Error('offline');return{ok:true,status:200,json:async()=>({authenticated:signedIn,...(signedIn?{user}:{})})};}
    if(url==='/api/config')return{ok:true,status:200,json:async()=>({orcid_configured:configured})};
    if(url==='/auth/logout'){if(logoutFailure==='network')throw new Error('offline');if(!logoutFailure)signedIn=false;return{ok:!logoutFailure,status:logoutFailure?500:200,json:async()=>({authenticated:false})};}
    if((url==='/api/saved' || url.startsWith('/api/saved?')) && !options.method){if(getSavedResponse)return getSavedResponse({url,options,signedIn});if(getSavedFailure)throw new Error('offline');return{ok:signedIn,status:signedIn?200:401,json:async()=>({papers:serverPapers})};}
    if(url.startsWith('/api/saved') && options.method){if(saveFailure==='network')throw new Error('offline');if(saveFailure===401)signedIn=false;if(saveFailure)return{ok:false,status:typeof saveFailure==='number'?saveFailure:500,json:async()=>({})};if(!signedIn)return{ok:false,status:401,json:async()=>({})};if(options.method==='POST'){const p=JSON.parse(options.body).paper;serverPapers=[p,...serverPapers.filter(item=>item.id!==p.id)];}else serverPapers=serverPapers.filter(item=>item && (item.id||'').replace(/v\d+$/,'')!==decodeURIComponent(url.split('/api/saved/')[1]));return{ok:true,status:200,json:async()=>({papers:serverPapers})};}
    throw new Error('Unexpected test request: '+url);
  };
  const context=vm.createContext({document,window,localStorage,sessionStorage,fetch,URL,URLSearchParams,setTimeout:()=>1,clearTimeout(){},listenToPaper(){},listenToText(){},stopSpeech(){},openAudioSettings(){},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}}});
  vm.runInContext(source+'\nthis.api={mountShell,authReady,isAuthenticated,requireSignIn,loadSaved,isSaved,toggleSaved,refreshSaved};',context);
  return{api:context.api,header,footer,document,body,head,button,menu,label,name,record,signout,authOnly,localStorage,sessionStorage,assigned,replaced,calls,events,toast:()=>document.getElementById('siteToast')?.textContent||''};
}
