import {computeAttention, createAttentionExample} from './attention.js';

const byId = id => document.getElementById(id);
let example = createAttentionExample(), matrix = 'Q', tokenIndex = 0, step = 1;
let lastStrongest = null, resultAnimation = null;
const ns = 'http://www.w3.org/2000/svg';
const fmt = value => (Math.abs(value) < 0.0005 ? 0 : value).toFixed(2);
const explanations = [
  'Скалярное произведение Q·K показывает сходство запроса с каждым ключом. Затем результат делится на √2, потому что в этом примере размерность ключа равна 2.',
  'Softmax превращает оценки в положительные веса с суммой 1. Чем выше вес токена, тем больше его значение V влияет на результат.',
  'Каждый вектор V умножается на свой вес. Сумма этих векторов — итоговый выход attention. Изменение V меняет результат, но не веса внимания.'
];

function createRows() {
  for (const [index, label] of example.tokens.entries()) {
    const row = document.createElement('div'); row.className = 'attention-row'; row.dataset.index = String(index);
    const name = document.createElement('span'); name.textContent = label;
    const track = document.createElement('div'); track.className = 'bar-track'; track.setAttribute('aria-hidden','true');
    const fill = document.createElement('div'); fill.className = 'bar-fill'; track.append(fill);
    const number = document.createElement('output'); number.setAttribute('aria-label', `Вес ${label}`);
    row.append(name, track, number); byId('attentionRows').append(row);
    const scoreRow = row.cloneNode(true); scoreRow.className = 'score-row';
    scoreRow.querySelector('.bar-track').className = 'score-track'; scoreRow.querySelector('.bar-fill').className = 'score-fill';
    scoreRow.querySelector('output').setAttribute('aria-label', `Оценка ${label}`); byId('scoreRows').append(scoreRow);
    const line = document.createElementNS(ns,'line'); line.classList.add('value-vector');
    line.setAttribute('x1','150'); line.setAttribute('y1','100'); line.dataset.value = String(index);
    const dot = document.createElementNS(ns,'circle'); dot.classList.add('value-vector-dot'); dot.setAttribute('r','3'); dot.dataset.value = String(index);
    byId('valueVectors').append(line,dot);
  }
}

function updateControls() {
  const values = example[matrix][matrix === 'Q' ? 0 : tokenIndex];
  byId('tokenChooser').hidden = matrix === 'Q';
  for (const button of document.querySelectorAll('[data-matrix]')) button.setAttribute('aria-pressed', String(button.dataset.matrix === matrix));
  for (const button of document.querySelectorAll('[data-item-index]')) button.setAttribute('aria-pressed', String(Number(button.dataset.itemIndex) === tokenIndex));
  for (const [axis, index] of [['X',0],['Y',1]]) {
    const key = axis.toLowerCase();
    byId(`vector${axis}`).value = String(values[index]);
    byId(`${key}Label`).textContent = matrix + (index ? '₂' : '₁');
    byId(`vector${axis}`).setAttribute('aria-label',`${matrix}, ${matrix === 'Q' ? 'запрос' : example.tokens[tokenIndex]}, координата ${index + 1}`);
    byId(`${key}Value`).textContent = fmt(values[index]);
  }
}

function setOutput(vector) {
  byId('outputResult').textContent = `[${fmt(vector[0])}, ${fmt(vector[1])}]`;
  const x = 150 + vector[0]*55, y = 100 - vector[1]*35;
  byId('outputArrow').setAttribute('x2',String(x)); byId('outputArrow').setAttribute('y2',String(y));
  byId('outputDot').setAttribute('cx',String(x)); byId('outputDot').setAttribute('cy',String(y));
}

function render({announce = true} = {}) {
  const data = computeAttention(example), weights = data.weights[0];
  const strongest = weights.indexOf(Math.max(...weights));
  document.querySelectorAll('.attention-row').forEach((row,index) => {
    row.querySelector('.bar-fill').style.width = `${weights[index]*100}%`;
    row.querySelector('output').textContent = `${(weights[index]*100).toFixed(1)}%`;
    row.dataset.strongest = String(index === strongest);
  });
  const scores = data.scaledScores[0], scale = Math.max(1,...scores.map(Math.abs));
  document.querySelectorAll('.score-row').forEach((row,index) => {
    const fill = row.querySelector('.score-fill'), width = Math.abs(scores[index])/scale*50;
    fill.style.width = `${width}%`; fill.style.left = `${scores[index] < 0 ? 50-width : 50}%`;
    row.querySelector('output').textContent = fmt(scores[index]);
  });
  for (const node of byId('valueVectors').children) {
    const v = example.V[Number(node.dataset.value)], x = 150 + v[0]*55, y = 100-v[1]*35;
    node.setAttribute(node.tagName === 'line' ? 'x2' : 'cx', String(x));
    node.setAttribute(node.tagName === 'line' ? 'y2' : 'cy', String(y));
  }
  if (resultAnimation) cancelAnimationFrame(resultAnimation);
  // The vector shows the real computed endpoint; only the transition is animated.
  const previous = [ (Number(byId('outputDot').getAttribute('cx'))-150)/55, (100-Number(byId('outputDot').getAttribute('cy')))/35 ];
  const target = data.output[0];
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) setOutput(target);
  else {
    const started = performance.now();
    function animate(now) {
      const t = Math.min(1,(now-started)/220), eased = 1-(1-t)**3;
      const current = previous.map((v,i)=>v+(target[i]-v)*eased);
      setOutput(current);
      if (t < 1) resultAnimation = requestAnimationFrame(animate);
      else {setOutput(target);resultAnimation = null;}
    }
    resultAnimation = requestAnimationFrame(animate);
  }
  byId('outputResult').setAttribute('aria-label',`Итоговый вектор: ${fmt(target[0])}, ${fmt(target[1])}`);
  const tied = weights.every(w=>Math.abs(w-weights[0]) < 1e-9);
  const message = tied ? 'Все токены имеют одинаковый вес: результат — среднее значений V.' : `Больше всего влияет «${example.tokens[strongest]}»: ${(weights[strongest]*100).toFixed(1)}% внимания.`;
  if (announce || lastStrongest === null) byId('changeSummary').textContent = message;
  lastStrongest = strongest;
}

function showStep(value) {
  step = value;
  for (const button of document.querySelectorAll('[data-step]')) {
    const selected = Number(button.dataset.step) === step;
    button.setAttribute('aria-selected',String(selected)); button.tabIndex = selected ? 0 : -1;
  }
  byId('stepPanel').setAttribute('aria-labelledby',`step${step}`);
  byId('weightView').hidden = step !== 1; byId('scoreView').hidden = step !== 0; byId('mixView').hidden = step !== 2;
  byId('visualTitle').textContent = ['Оценки Q·K / √2','Веса внимания','Взвешенная сумма V'][step];
  byId('weightTotal').textContent = ['До softmax','Σ = 100%','Выход: 2 числа'][step];
  byId('stepExplanation').textContent = explanations[step];
}

document.addEventListener('formula-selected', event => {
  if (event.detail?.formula !== 'scaled-attention' || event.detail?.paperId?.replace(/v\d+$/,'') !== '1706.03762') return;
  byId('emptyPanel').hidden = true; byId('activePanel').hidden = false;
  byId('equationReference').textContent = 'ФОРМУЛА 01 · РАЗДЕЛ 3.2.1';
  render({announce:false});
});
document.addEventListener('formula-unsupported', () => {
  byId('selectionFeedback').textContent = 'Это выделение не распознано как формула (1). Выделите всю формулу Attention на странице 4, включая softmax и дробь.';
  if (!byId('activePanel').hidden) byId('changeSummary').textContent = 'Новое выделение не поддерживается. Здесь по-прежнему открыт разбор формулы Attention (1).';
});
byId('closeLens').addEventListener('click',()=>{byId('activePanel').hidden=true;byId('emptyPanel').hidden=false;byId('selectionFeedback').textContent='';});
document.querySelectorAll('[data-matrix]').forEach(button=>button.addEventListener('click',()=>{matrix=button.dataset.matrix;updateControls();}));
document.querySelectorAll('[data-item-index]').forEach(button=>button.addEventListener('click',()=>{tokenIndex=Number(button.dataset.itemIndex);updateControls();}));
for (const [id,index] of [['vectorX',0],['vectorY',1]]) byId(id).addEventListener('input',event=>{
  const value=Number(event.target.value); if(!Number.isFinite(value) || value < -2 || value > 2) return;
  example[matrix][matrix==='Q'?0:tokenIndex][index]=value;
  byId(index ? 'yValue' : 'xValue').textContent=fmt(value); render();
});
byId('resetExample').addEventListener('click',()=>{example=createAttentionExample();matrix='Q';tokenIndex=0;updateControls();render();});
for (const button of document.querySelectorAll('[data-step]')) {
  button.addEventListener('click',()=>showStep(Number(button.dataset.step)));
  button.addEventListener('keydown',event=>{
    let target=step;
    if(event.key==='ArrowRight')target=(step+1)%3;else if(event.key==='ArrowLeft')target=(step+2)%3;else if(event.key==='Home')target=0;else if(event.key==='End')target=2;else return;
    event.preventDefault();showStep(target);byId(`step${target}`).focus();
  });
}
createRows(); updateControls(); showStep(1); render({announce:false});
