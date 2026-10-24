import {connectFormulaService,disconnectFormulaService,formulaRequest} from './api-client.js';
import {isLocalPreview} from './selection.js';

// This controller renders structured text, never provider HTML or code. The
// original PDF is fetched again for each explanation, not retained in storage.
export function createPaperController({doc=globalThis.document,api=globalThis.chrome,
  href=globalThis.location?.href||'',showIssue=()=>{},showExample=()=>{},hideExample=()=>{},
  showSelection=()=>{},showFormula=()=>{},clearSelection=()=>{},isPaperMode=()=>true,
  service={connect:connectFormulaService,request:formulaRequest,disconnect:disconnectFormulaService}}={}){
  const $=id=>doc.getElementById(id),preview=isLocalPreview(href);
  let source=null,context=null,selection='',generation=0,operation=null,connection=null,disposed=false,connecting=null;
  const text=(tag,value,className)=>{const node=doc.createElement(tag);node.textContent=value;if(className)node.className=className;return node;};
  const status=value=>{$('paperStatus').textContent=value;};
  function controls(){
    $('analyzePaper').disabled=!!operation||!source||preview;
    $('analyzePaper').textContent=operation?'Working…':context?'Analyze again':'Analyze paper';
    $('analyzeFormula').disabled=!!operation||(isPaperMode()&&!context&&!preview);
  }
  function resetOutput(){ $('paperFormulaView').hidden=true;hideExample(); }
  function setSource(next){
    if(source?.originalUrl===next?.originalUrl){controls();return;}
    generation++;operation?.abort();operation=null;source=next||null;context=null;selection='';resetOutput();
    $('paperPanel').classList.remove('context-ready');
    $('paperTitle').textContent='Start with the paper.';
    $('paperSource').hidden=!source;
    if(source){$('paperSource').href=source.originalUrl;$('paperSource').textContent=source.label+' ↗';status('Ready to analyze this PDF.');}
    else{$('paperSource').removeAttribute('href');status('Open a paper PDF to get started.');}
    controls();
  }
  async function message(type,extra={}){
    const reply=await api.runtime.sendMessage({type,...extra});
    if(!reply?.ok)throw new Error(reply?.error||'The paper could not be read. Reload the extension and try again.');
    return reply.data;
  }
  async function refresh(){
    if(disposed||preview||connecting)return;
    const version=generation;
    try{const active=await message('formula/paper-source');if(version===generation&&!connecting){if(active.source.originalUrl!==source?.originalUrl){setSource(active.source);clearSelection();}}}
    catch{if(version===generation&&!connecting&&source){setSource(null);clearSelection();}}
  }
  function begin(){operation?.abort();operation=new AbortController();const version=++generation;controls();return {version,controller:operation,sourceURL:source?.originalUrl};}
  const current=job=>!disposed&&generation===job.version&&!job.controller.signal.aborted&&source?.originalUrl===job.sourceURL;
  async function connected(job){
    let record;connecting=job;
    try{record=await service.connect({api,signal:job.controller.signal,onStatus:value=>{if(current(job))status(value);}});}finally{if(connecting===job)connecting=null;}
    if(!current(job))return null;
    if(connection?.accessToken!==record.accessToken){context=null;connection=record;}
    return record;
  }
  async function request(path,body,job,record){
    const timer=setTimeout(()=>job.controller.abort(),90000);
    try{return (await service.request(path,body,{accessToken:record.accessToken,signal:job.controller.signal})).data;}
    catch(error){if(error.status===401&&current(job)){connection=null;context=null;await service.disconnect(api);}throw error;}
    finally{clearTimeout(timer);}
  }
  function finish(job){if(generation===job.version){operation=null;controls();}}
  function failure(error,job){if(disposed||generation!==job.version||source?.originalUrl!==job.sourceURL)return;const message=job.controller.signal.aborted?'The analysis was cancelled or took too long. Try again.':error.message||'The analysis could not be completed.';status(message);showIssue(message);}
  async function captureTab(job){const active=await message('formula/paper-source');if(active.source.originalUrl!==job.sourceURL)throw new Error('Return to the original selected PDF before continuing.');job.tabId=active.tabId;}
  async function readPaper(job){return message('formula/read-paper',{sourceId:source.sourceId,expectedOriginalURL:job.sourceURL,expectedTabId:job.tabId});}
  async function verifyTab(job){const active=await message('formula/paper-source');return active.tabId===job.tabId&&active.source.originalUrl===job.sourceURL;}
  async function analyze(){
    if(!source||preview||operation)return;
    const job=begin();context=null;resetOutput();showIssue();
    try{
      await captureTab(job);if(!current(job))return;
      const record=await connected(job);if(!current(job))return;
      status('Downloading the complete original PDF…');
      let upload=await readPaper(job);if(!current(job))return;
      status('Reading the paper and its mathematical context…');
      const result=await request('/api/extension/papers',upload,job,record);upload=null;if(!current(job))return;const matches=await verifyTab(job);if(!current(job)||!matches)return;
      if(typeof result.contextId!=='string'||!result.paper?.title)throw new Error('The service did not return a paper analysis.');
      context=result;$('paperTitle').textContent=result.paper.title;$('paperPanel').classList.add('context-ready');
      status('Paper context is ready. Select a formula in the PDF, then explain it.');
    }catch(error){failure(error,job);}finally{finish(job);}
  }
  function render(result){
    resetOutput();
    if(result.status!=='ready'){
      showIssue((result.limitations||['The paper does not define this selection clearly. Select the complete formula and its definition.']).join(' '));return;
    }
    $('formulaTitle').textContent=result.formulaName||'Formula';
    $('purposeText').textContent=result.purpose||'';
    $('applicationsList').replaceChildren();
    for(const item of result.applications||[]){
      const li=doc.createElement('li');li.append(text('strong',item.field+'. '),doc.createTextNode(item.explanation+' '),text('span',item.source==='paper'?'In this paper':'Broader use','application-origin'));
      $('applicationsList').append(li);
    }
    if(!result.applications?.length)$('applicationsList').append(text('li','No application is supported by the available context.'));
    const example=result.workedExample||{},worked=$('workedExample');worked.replaceChildren();
    if(example.assumptions?.length){worked.append(text('p','Illustrative assumptions','example-label'));const list=doc.createElement('ul');for(const value of example.assumptions)list.append(text('li',value));worked.append(list);}
    if(example.steps?.length){const steps=doc.createElement('ol');for(const value of example.steps)steps.append(text('li',value));worked.append(steps);}
    if(example.result)worked.append(text('p',example.result,'example-result'));
    $('conclusionText').textContent=result.conclusion||'';
    const evidence=$('sourceEvidence');evidence.replaceChildren();$('evidenceDetails').open=false;
    for(const item of result.evidence||[]){
      const line=doc.createElement('p'),link=doc.createElement('a');link.textContent=`PDF page ${item.page} ↗`;
      if(source?.originalUrl&&Number.isSafeInteger(item.page)&&item.page>0){const url=new URL(source.originalUrl);url.hash=`page=${item.page}`;link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';}
      line.append(link);evidence.append(line,text('blockquote',item.quote));
    }
    evidence.append(text('p','AI-generated interpretation. Check the quoted passages and calculations against the original paper.'));
    for(const item of result.limitations||[])evidence.append(text('p',item));
    $('paperFormulaView').hidden=false;showIssue();
    if(example.interactive?.expression&&example.interactive?.purpose)showExample(example.interactive);
  }
  async function explain(rawText){
    if(preview){showIssue('This is an interface preview. Use the sample button or the separate expression sandbox.');return;}
    if(!source||!context){showIssue('Analyze this paper first so the formula can be explained in context.');return;}
    if(!rawText.trim()||rawText.length>2000){showIssue('Select a complete formula, up to 2000 characters.');return;}
    if(operation)return;
    selection=rawText;const selectedContext=context,job=begin();resetOutput();showIssue();
    try{
      await captureTab(job);if(!current(job))return;
      const record=await connected(job);if(!current(job))return;
      if(!context){showIssue('The account connection changed. Analyze the paper again.');status('Analyze this paper for the connected account.');return;}
      status('Checking the selected formula against the complete PDF…');
      let upload=await readPaper(job);if(!current(job))return;
      const result=await request('/api/extension/explain',{contextId:selectedContext.contextId,selectedText:rawText,pdfBase64:upload.pdfBase64},job,record);upload=null;
      if(!current(job)||selection!==rawText)return;const matches=await verifyTab(job);if(!current(job)||selection!==rawText||!matches)return;
      render(result);showFormula(rawText);status(result.status==='ready'?'Formula explained using this paper.':'More context is needed for this selection.');
    }catch(error){failure(error,job);}finally{finish(job);}
  }
  function selected(rawText,nextSource){generation++;operation?.abort();operation=null;setSource(nextSource);selection=rawText;resetOutput();controls();if(!context)showIssue('Analyze this paper first. The selected formula will stay here.');}
  function edited(){selection=$('expressionInput').value;generation++;operation?.abort();operation=null;resetOutput();controls();}
  function clear(){selection='';generation++;operation?.abort();operation=null;resetOutput();controls();void refresh();}
  $('paperPrivacy').textContent='PDFs and selections are sent to Easy ArXiv and Google AI. Context is cached for up to 24 hours; Easy ArXiv does not store the PDF. Limit: 6 MiB. Requires ORCID. Explaining a formula sends the PDF again.';
  $('analyzePaper').addEventListener('click',analyze);
  api?.tabs?.onActivated?.addListener(()=>{void refresh();});
  api?.tabs?.onUpdated?.addListener((_id,change)=>{if(change.url||change.status==='complete')void refresh();});
  if(preview){
    $('paperTitle').textContent='Interface preview';status('Sample content only. No PDF or formula is sent to the AI service.');
    $('paperPrivacy').textContent='This local preview shows the proposed layout. It does not represent a live article analysis.';
    $('analyzePaper').disabled=true;$('previewBadge').hidden=false;$('previewExample').hidden=false;
    $('previewExample').addEventListener('click',()=>{
      source={originalUrl:'https://arxiv.org/pdf/2106.09685',label:'LoRA · arXiv:2106.09685',sourceId:'arxiv:2106.09685'};
      showSelection('W = W_0 + matmul(B, A)',source);
      $('paperPanel').classList.add('context-ready');
      $('paperTitle').textContent='LoRA: Low-Rank Adaptation';status('Sample article context · interface preview');
      $('paperSource').hidden=false;$('paperSource').href=source.originalUrl;$('paperSource').textContent='Source paper ↗';
      render({status:'ready',formulaName:'Low-rank weight update',
        purpose:'Adapt a pretrained model by learning a small update BA while keeping its original weights W₀ fixed.',
        applications:[{field:'Language models',explanation:'Task-specific adaptation, including summarization and natural-language-to-SQL.',source:'paper'}],
        workedExample:{assumptions:['Toy values, not measurements from the paper. Set W₀ = [[1,0],[0,1]], A = [[1,0]] and B = [[0.1],[0.2]].'],
          steps:['Multiply B by A: BA = [[0.1,0],[0.2,0]].','Add BA to W₀: W = [[1.1,0],[0.2,1]].'],
          result:'The first column changes; the second stays the same in this toy example.',
          interactive:{expression:'W_0 + matmul(B, A)',bindings:{W_0:[[1,0],[0,1]],B:[[.1],[.2]],A:[[1,0]]},purpose:'Change A or B to see which entries of the adapted weight matrix change.'}},
        conclusion:'A low-rank update changes the model through two smaller matrices. This toy calculation illustrates the operation; it does not predict model quality.',
        evidence:[{page:4,quote:'During training, W0 is frozen and does not receive gradient updates'}],limitations:['The paper also describes a scaling factor. This toy example uses a scale of 1.']});
      showFormula('W = W_0 + matmul(B, A)');
    });
  }else{controls();void refresh();}
  return {selected,explain,edited,clear,refresh,isWorking:()=>!!operation,ignoreSelection:(raw,nextSource)=>!!operation&&raw===selection&&nextSource?.originalUrl===source?.originalUrl,dispose(){disposed=true;generation++;operation?.abort();}};
}
