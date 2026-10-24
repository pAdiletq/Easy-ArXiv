import {prepareExpression,compileFormula} from './formula-engine.js';
import {createPaperController} from './paper-controller.js';
const $=id=>document.getElementById(id), svgNS='http://www.w3.org/2000/svg', mathNS='http://www.w3.org/1998/Math/MathML';
let worker=null,requestId=0,timeout=null,inputDelay=null,expression='',bindings=Object.create(null),program=null;
let view={variable:undefined,min:-4,max:4};
let mode='paper',preserveSelection=false,papers;
const examples={gaussian:'f(x) = exp(-x^2 / (2*s^2))',wave:'f(t) = A*sin(w*t)',matrix:'softmax([1, 2, 3])'};
const numberText=n=>Math.abs(n)<1e-12?'0':Math.abs(n)>=1e5||Math.abs(n)<1e-3?n.toExponential(2):Number(n.toPrecision(5)).toString();
const axisText=n=>Math.abs(n)<1e-12?'0':Math.abs(n)>=1e4||Math.abs(n)<1e-3?n.toExponential(1).replace('e+','e'):Number(n.toPrecision(2)).toString();
function issue(message=''){$('formulaIssue').textContent=message;$('formulaIssue').hidden=!message;}
function cancelCalculation(){requestId++;clearTimeout(timeout);clearTimeout(inputDelay);if(worker)worker.terminate();worker=null;document.querySelector('.formula-panel').removeAttribute('aria-busy');}
function editorVisible(show){document.querySelector('.expression-editor').hidden=!show;$('formattedExpression').hidden=show;}
function clearFormula(){cancelCalculation();program=null;expression='';bindings=Object.create(null);$('activePanel').hidden=true;$('emptyPanel').hidden=false;$('analysisView').hidden=true;$('interactiveExample').hidden=true;$('paperFormulaView').hidden=true;}
function openFormula(rawText,source=null,demo=false){
  mode=source?'paper':'sandbox';preserveSelection=false;
  cancelCalculation();program=null;bindings=Object.create(null);view={variable:undefined,min:-4,max:4};$('plotMin').value='-4';$('plotMax').value='4';
  $('emptyPanel').hidden=true;$('activePanel').hidden=false;$('analysisView').hidden=true;$('paperFormulaView').hidden=true;$('interactiveExample').hidden=true;$('interactiveExample').open=false;$('formulaTitle').textContent=source?'Formula':'Expression sandbox';$('rawSelection').textContent=rawText;
  $('sourceDetails').hidden=!source;$('sourceDetails').open=false;$('selectedSource').hidden=!source?.originalUrl;
  if(source?.originalUrl){$('selectedSource').href=source.originalUrl;$('selectedSource').textContent=source.label;}else{$('selectedSource').removeAttribute('href');$('selectedSource').textContent='';}
  $('parametersDetails').open=false;$('calculationDetails').open=false;$('exampleDisclosure').textContent=demo?'Illustrative example. You can change the values.':'Illustrative values. Interpret the formula using the paper.';
  let prepared;try{prepared=prepareExpression(rawText);}catch(error){prepared={expression:rawText,warnings:[error.message]};}
  $('expressionInput').value=prepared.expression;$('analyzeFormula').textContent=source?'Explain formula':'Explore expression';$('analyzeFormula').disabled=false;editorVisible(true);
  issue(prepared.warnings?.length?prepared.warnings.join(' '):source?'Check fractions, powers and subscripts before continuing.':'');
}
function m(tag,text=null,children=[]){const node=document.createElementNS(mathNS,tag);if(text!==null)node.textContent=text;node.append(...children);return node;}
const row=children=>m('mrow',null,children), atom=node=>['number','symbol','call','array'].includes(node?.type);
const bracket=node=>row([m('mo','('),renderMath(node),m('mo',')')]);
function renderMath(node){
  if(!node||typeof node!=='object')return m('mtext','?');
  if(node.type==='number')return m('mn',String(node.value));
  if(node.type==='symbol'){const parts=node.name.split('_');return parts.length===2?m('msub',null,[m('mi',parts[0]),m('mtext',parts[1])]):m('mi',node.name);}
  if(node.type==='unary')return row([m('mo',node.op==='-'?'−':'+'),atom(node.arg)?renderMath(node.arg):bracket(node.arg)]);
  if(node.type==='binary'){
    if(node.op==='/')return m('mfrac',null,[renderMath(node.left),renderMath(node.right)]);
    if(node.op==='^')return m('msup',null,[atom(node.left)?renderMath(node.left):bracket(node.left),renderMath(node.right)]);
    const child=n=>node.op==='*'&&n.type==='binary'&&['+','-'].includes(n.op)?bracket(n):renderMath(n);
    return row([child(node.left),m('mo',({'*':'·','-':'−'})[node.op]||node.op),node.op==='-'&&!atom(node.right)?bracket(node.right):child(node.right)]);
  }
  if(node.type==='array'){
    if(node.items.every(item=>item.type==='array'))return row([m('mo','['),m('mtable',null,node.items.map(r=>m('mtr',null,r.items.map(item=>m('mtd',null,[renderMath(item)]))))),m('mo',']')]);
    const parts=[];node.items.forEach((item,i)=>{if(i)parts.push(m('mo',','));parts.push(renderMath(item));});return row([m('mo','['),...parts,m('mo',']')]);
  }
  if(node.type==='call'){
    if(node.name==='matmul'&&node.args.length===2)return row([renderMath(node.args[0]),m('mo','·'),renderMath(node.args[1])]);
    if(node.name==='sqrt'&&node.args.length===1)return m('msqrt',null,[renderMath(node.args[0])]);
    if(node.name==='pow'&&node.args.length===2)return m('msup',null,[atom(node.args[0])?renderMath(node.args[0]):bracket(node.args[0]),renderMath(node.args[1])]);
    if(node.name==='transpose'&&node.args.length===1)return m('msup',null,[atom(node.args[0])?renderMath(node.args[0]):bracket(node.args[0]),m('mi','T')]);
    const args=[];node.args.forEach((arg,i)=>{if(i)args.push(m('mo',','));args.push(renderMath(arg));});const name=m('mi',node.name);name.setAttribute('mathvariant','normal');return row([name,m('mo','('),...args,m('mo',')')]);
  }return m('mtext','?');
}
function formatExpression(meta){const math=m('math');math.setAttribute('display','block');if(meta.assignment)math.append(m('mtext',meta.assignment),m('mo','='));math.append(renderMath(meta.ast));$('formulaDisplay').replaceChildren(math);}
function s(tag,attrs={},text=null){const node=document.createElementNS(svgNS,tag);for(const [key,value]of Object.entries(attrs))node.setAttribute(key,String(value));if(text!==null)node.textContent=text;return node;}
function drawCurve(plot){
  const target=$('formulaPlot');target.replaceChildren();target.removeAttribute('hidden');target.setAttribute('viewBox','0 0 340 210');target.setAttribute('aria-label',`Dependence on ${plot.variable}`);
  const finite=plot.points.filter(p=>Number.isFinite(p[1]));if(!finite.length)return false;
  const dataLow=Math.min(...finite.map(p=>p[1])),dataHigh=Math.max(...finite.map(p=>p[1]));let low=dataLow,high=dataHigh;if(low===high){const pad=Math.max(1,Math.abs(low)*.1);low-=pad;high+=pad;}else{const pad=(high-low)*.09;low-=pad;high+=pad;if(dataLow>=0&&dataLow<pad)low=0;if(dataHigh<=0&&Math.abs(dataHigh)<pad)high=0;}
  const x=n=>44+(n-plot.min)/(plot.max-plot.min)*278,y=n=>180-(n-low)/(high-low)*160;
  for(let i=0;i<5;i++)target.append(s('path',{class:'plot-grid',d:`M44 ${20+i*40}H322 M${44+i*69.5} 20V180`}));
  target.append(s('path',{class:'plot-axis',d:'M44 20V180H322'}));if(low<0&&high>0)target.append(s('path',{class:'plot-axis',d:`M44 ${y(0)}H322`}));if(plot.min<0&&plot.max>0)target.append(s('path',{class:'plot-axis',d:`M${x(0)} 20V180`}));
  target.append(s('text',{x:37,y:25,'text-anchor':'end'},axisText(high)),s('text',{x:37,y:183,'text-anchor':'end'},axisText(low)),s('text',{x:44,y:202},axisText(plot.min)),s('text',{x:322,y:202,'text-anchor':'end'},axisText(plot.max)));
  let path='',previous=null;for(const point of plot.points){if(!Number.isFinite(point[1])){previous=null;continue;}const jump=previous&&Math.abs(point[1]-previous[1])>(high-low)*.75;path+=`${previous&&!jump?'L':'M'}${x(point[0]).toFixed(2)} ${y(point[1]).toFixed(2)} `;previous=point;}
  target.append(s('path',{class:'plot-curve',d:path}));const dot=s('circle',{class:'plot-point',r:4}),label=s('text',{x:315,y:15,'text-anchor':'end',class:'chart-value'});dot.style.display='none';target.append(dot,label);
  target.onpointermove=event=>{const rect=target.getBoundingClientRect(),pointer=(event.clientX-rect.left)/rect.width*340,wanted=plot.min+(pointer-44)/278*(plot.max-plot.min),nearest=finite.reduce((best,p)=>Math.abs(p[0]-wanted)<Math.abs(best[0]-wanted)?p:best,finite[0]);dot.style.display='';dot.setAttribute('cx',String(x(nearest[0])));dot.setAttribute('cy',String(y(nearest[1])));label.textContent=`${plot.variable} = ${numberText(nearest[0])} · ${numberText(nearest[1])}`;};target.onpointerleave=()=>{dot.style.display='none';label.textContent='';};return true;
}
function drawVector(values){
  const target=$('formulaPlot');target.replaceChildren();target.removeAttribute('hidden');target.onpointermove=null;target.onpointerleave=null;const height=Math.max(140,values.length*28+26);target.setAttribute('viewBox',`0 0 340 ${height}`);target.setAttribute('aria-label','Vector component values');const scale=Math.max(1e-12,...values.map(Math.abs));
  values.forEach((value,i)=>{const yy=15+i*28,width=Math.abs(value)/scale*111;target.append(s('text',{x:18,y:yy+12},String(i+1)),s('rect',{x:45,y:yy,width:222,height:16,rx:3,class:'vector-track'}));const bar=s('rect',{x:value<0?156-width:156,y:yy,width,height:16,rx:3,class:`vector-bar${value<0?' negative':''}`});bar.append(s('title',{},`Component ${i+1}: ${numberText(value)}`));target.append(bar,s('text',{x:330,y:yy+12,'text-anchor':'end'},numberText(value)));});
  target.append(s('path',{class:'plot-axis',d:`M156 9V${height-20}`}),s('text',{x:156,y:height-3,'text-anchor':'middle'},'0'));
}
function drawMatrix(rows){const table=document.createElement('table');table.setAttribute('aria-label',`Matrix ${rows.length} by ${rows[0].length}`);const max=Math.max(1e-12,...rows.flat().map(Math.abs));rows.forEach((values,ri)=>{const tr=document.createElement('tr');values.forEach((value,ci)=>{const td=document.createElement('td');td.textContent=numberText(value);td.title=`Row ${ri+1}, column ${ci+1}: ${value}`;td.style.backgroundColor=`rgba(128,0,255,${.04+Math.abs(value)/max*.17})`;tr.append(td);});table.append(tr);});$('matrixView').replaceChildren(table);$('matrixView').hidden=false;}
function renderVisualization(response){
  $('formulaPlot').setAttribute('hidden','');$('matrixView').hidden=true;$('scalarResult').hidden=true;$('plotToolbar').hidden=true;const validCurve=response.plot&&response.plot.points.some(point=>Number.isFinite(point[1]));
  if(validCurve){drawCurve(response.plot);$('plotToolbar').hidden=false;}else if(typeof response.value==='number'){$('scalarResult').textContent=numberText(response.value);$('scalarResult').hidden=false;}else if(Array.isArray(response.value)){if(response.value.every(v=>typeof v==='number'))drawVector(response.value);else if(response.value.every(r=>Array.isArray(r)&&r.every(v=>typeof v==='number')))drawMatrix(response.value);}
  $('visualization').hidden=!validCurve&&response.value===null;
}
function parameterValue(text){
  if(text.length>2000)throw new Error('This parameter value is too large.');const value=text.trim().startsWith('[')?JSON.parse(text):Number(text.trim());
  const valid=n=>typeof n==='number'?Number.isFinite(n):Array.isArray(n)&&n.length<=16&&n.length>0&&n.every(child=>typeof child==='number'?Number.isFinite(child):Array.isArray(child)&&child.length<=16&&child.length>0&&child.every(v=>typeof v==='number'&&Number.isFinite(v)));
  if(!text.trim()||!valid(value))throw new Error('Enter a number, vector [1,2] or matrix [[1,0],[0,1]].');return value;
}
function renderParameters(names){
  $('parameterFields').replaceChildren();$('parametersDetails').hidden=!names.length;
  for(const name of names){
    const label=document.createElement('label');label.className='parameter-row';const caption=document.createElement('span');caption.className='parameter-name';caption.textContent=name;
    const field=document.createElement('input');field.type='text';field.className='parameter-input';field.maxLength=2000;field.value=JSON.stringify(bindings[name]);field.setAttribute('aria-label',`Value of ${name}`);field.autocomplete='off';field.spellcheck=false;label.append(caption,field);let slider=null;
    if(typeof bindings[name]==='number'){slider=document.createElement('input');slider.type='range';slider.className='parameter-range';slider.min=String(Math.min(-5,bindings[name]*2));slider.max=String(Math.max(5,bindings[name]*2));slider.step='0.05';slider.value=String(bindings[name]);slider.setAttribute('aria-label',`Change ${name}`);slider.addEventListener('input',()=>{bindings[name]=Number(slider.value);field.value=String(bindings[name]);scheduleCalculation();});label.append(slider);}
    const updateField=showError=>{try{bindings[name]=parameterValue(field.value);field.removeAttribute('aria-invalid');if(slider){slider.hidden=typeof bindings[name]!=='number';if(!slider.hidden){slider.min=String(Math.min(-5,bindings[name]*2));slider.max=String(Math.max(5,bindings[name]*2));slider.value=String(bindings[name]);}}issue();scheduleCalculation();}catch(error){cancelCalculation();field.setAttribute('aria-invalid','true');if(showError)issue(error instanceof SyntaxError?'Check brackets and commas in this value.':error.message);}};
    field.addEventListener('input',()=>updateField(false));field.addEventListener('change',()=>updateField(true));$('parameterFields').append(label);
  }const hint=document.createElement('p');hint.className='parameter-help';hint.textContent='Number: 1. Vector: [1,2]. Matrix: [[1,0],[0,1]].';$('parameterFields').append(hint);
}
function calculateInfo(response){const info=$('calculationInfo');info.replaceChildren();const description=document.createElement('p');description.textContent='Calculations run on your device. Variable names are case-sensitive. Initial values are illustrative.';const value=document.createElement('pre');value.textContent=response.value===null?response.valueError?.message||'No numerical result is available.':`Result: ${JSON.stringify(response.value)}`;const note=document.createElement('p');note.textContent=response.plot?'The selected variable changes while other values stay fixed. Undefined points are shown as gaps.':'The visualization follows the numerical result type.';info.append(description,value,note);}
function applyResponse(response,fresh){
  program=response.program;bindings=Object.assign(Object.create(null),response.bindings);
  if(fresh){$('plotVariable').replaceChildren();for(const name of program.variables.filter(n=>typeof bindings[n]==='number')){const option=document.createElement('option');option.value=name;option.textContent=name;$('plotVariable').append(option);}if(response.plot){view.variable=response.plot.variable;$('plotVariable').value=view.variable;}renderParameters(program.variables);if(!preserveSelection){formatExpression(program);editorVisible(false);}}
  $('analysisView').hidden=false;$('formulaExplanation').textContent=program.explanation;issue(response.valueError?response.plot?.points.some(point=>Number.isFinite(point[1]))?`At the selected point: ${response.valueError.message}`:response.valueError.message:'');renderVisualization(response);calculateInfo(response);
}
function scheduleCalculation(){cancelCalculation();inputDelay=setTimeout(()=>runCalculation(),80);}
function runCalculation({fresh=false,example=null}={}){
  if(fresh){expression=example?.expression||$('expressionInput').value.trim();bindings=Object.assign(Object.create(null),example?.bindings||{});view.variable=example?example.variable??'':undefined;view.min=example?.min??-4;view.max=example?.max??4;$('plotMin').value=String(view.min);$('plotMax').value=String(view.max);}if(!expression){issue('Enter the expression you want to explore.');return;}if(expression.length>2000){issue('Use a shorter expression, up to 2000 characters.');return;}
  cancelCalculation();const current=requestId;document.querySelector('.formula-panel').setAttribute('aria-busy','true');
  try{worker=new Worker('formula-worker.js',{type:'module'});}catch{issue('Local calculations could not start. Reload the extension.');document.querySelector('.formula-panel').removeAttribute('aria-busy');return;}
  timeout=setTimeout(()=>{if(current!==requestId)return;cancelCalculation();issue('This calculation took too long. Simplify the expression.');},10000);
  worker.onmessage=event=>{const response=event.data;if(response?.id!==current||current!==requestId)return;clearTimeout(timeout);worker.terminate();worker=null;document.querySelector('.formula-panel').removeAttribute('aria-busy');if(!response.ok){$('analysisView').hidden=true;editorVisible(true);issue(response.error?.message||'Check the expression.');return;}applyResponse(response,fresh);};
  worker.onerror=event=>{event.preventDefault();if(current!==requestId)return;cancelCalculation();issue('The local module did not start. Reload the extension and try again.');};worker.postMessage({id:current,expression,bindings,view});
}
function sandboxCalculation(){papers.clear();preserveSelection=false;$('interactiveExample').hidden=false;$('interactiveExample').open=true;$('visualPurpose').hidden=false;$('visualPurpose').textContent='Numerical sandbox: change the values to inspect the result. This does not explain a paper.';runCalculation({fresh:true});}
function showPaperExample(example){preserveSelection=true;$('interactiveExample').hidden=false;$('interactiveExample').open=false;$('visualPurpose').hidden=false;$('visualPurpose').textContent=example.purpose;$('exampleDisclosure').textContent='Illustrative inputs, not reported experimental results. Calculations run on your device.';runCalculation({fresh:true,example});}
function showSelectedFormula(rawText){
  try{formatExpression(compileFormula(rawText));}catch{$('formulaDisplay').textContent=rawText;}
  editorVisible(false);
}
papers=createPaperController({showIssue:issue,showExample:showPaperExample,hideExample(){cancelCalculation();$('interactiveExample').hidden=true;$('analysisView').hidden=true;},showSelection:openFormula,showFormula:showSelectedFormula,clearSelection:clearFormula,isPaperMode:()=>mode==='paper'});
document.addEventListener('formula-selection',event=>{if(typeof event.detail?.rawText!=='string'||event.detail.rawText.length>2000||papers.ignoreSelection(event.detail.rawText,event.detail.source))return;openFormula(event.detail.rawText,event.detail.source||null,event.detail.demo===true);if(event.detail.source)papers.selected(event.detail.rawText,event.detail.source);});
document.addEventListener('formula-clear',()=>{if(papers.isWorking()){void papers.refresh();return;}clearFormula();papers.clear();});
$('manualAnalyze').addEventListener('click',()=>{const text=$('manualExpression').value.trim();if(!text){$('manualExpression').focus();return;}openFormula(text);sandboxCalculation();});
for(const button of document.querySelectorAll('[data-example]'))button.addEventListener('click',()=>{openFormula(examples[button.dataset.example],null,true);sandboxCalculation();});
$('analyzeFormula').addEventListener('click',()=>{if(mode==='paper')void papers.explain($('expressionInput').value.trim());else sandboxCalculation();});$('editExpression').addEventListener('click',()=>{cancelCalculation();editorVisible(true);$('expressionInput').focus();});
$('expressionInput').addEventListener('input',()=>{cancelCalculation();$('analysisView').hidden=true;if(mode==='paper')papers.edited();issue();});
for(const id of ['manualExpression','expressionInput'])$(id).addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();$(id==='manualExpression'?'manualAnalyze':'analyzeFormula').click();}});
$('plotVariable').addEventListener('change',()=>{view.variable=$('plotVariable').value;runCalculation();});
for(const id of ['plotMin','plotMax'])$(id).addEventListener('change',()=>{const min=Number($('plotMin').value),max=Number($('plotMax').value);if(!Number.isFinite(min)||!Number.isFinite(max)||min>=max||Math.max(Math.abs(min),Math.abs(max))>1e6){issue('Enter an increasing range between -1,000,000 and 1,000,000.');return;}view.min=min;view.max=max;issue();runCalculation();});
$('closeLens').addEventListener('click',()=>{clearFormula();papers.clear();});window.addEventListener('pagehide',()=>{cancelCalculation();papers.dispose();});
