const PREFERENCES_KEY = 'easy-arxiv-web:audio:v1';
const DEFAULTS = Object.freeze({voiceURI:'', rate:.9, pitch:1.02});
let preferences = null;
let player = null;
let selectedContent = null;
let originButton = null;
let originalButtonHTML = '';
let utterance = null;
let token = 0;
let playback = 'idle';

export function normalizeAudioPreferences(raw) {
  return {
    voiceURI:typeof raw?.voiceURI==='string'?raw.voiceURI.slice(0,500):'',
    rate:typeof raw?.rate==='number' && Number.isFinite(raw.rate)?Math.min(1.3,Math.max(.6,raw.rate)):DEFAULTS.rate,
    pitch:typeof raw?.pitch==='number' && Number.isFinite(raw.pitch)?Math.min(1.2,Math.max(.8,raw.pitch)):DEFAULTS.pitch
  };
}
export function chooseDefaultVoice(voices) {
  const english=(Array.isArray(voices)?voices:[]).filter(voice=>/^en(?:[-_]|$)/i.test(voice.lang || ''));
  const score=voice=>(/natural|neural|online/i.test(voice.name)?20:0)+(/google|microsoft/i.test(voice.name)?10:0)+(/jenny|aria|samantha|ava|serena|susan|zira/i.test(voice.name)?5:0)+(voice.default?2:0);
  return english.reduce((best,voice)=>!best || score(voice)>score(best)?voice:best,null) || (Array.isArray(voices)?voices.find(voice=>voice.default)||voices[0]:null) || null;
}
export function readAudioPreferences() {
  if (!preferences) {
    let stored=null;try{stored=JSON.parse(localStorage.getItem(PREFERENCES_KEY)||'null');}catch{}
    preferences=normalizeAudioPreferences(stored);
  }
  return {...preferences};
}
function savePreferences(next) {
  preferences=normalizeAudioPreferences({...readAudioPreferences(),...next});
  try{localStorage.setItem(PREFERENCES_KEY,JSON.stringify(preferences));}catch{}
  return {...preferences};
}
const glyph={play:'<path d="m9 5 10 7-10 7Z"/>',pause:'<path d="M9 5v14M15 5v14"/>',stop:'<path d="M6 6h12v12H6Z"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',volume:'<path d="m11 5-6 4H2v6h3l6 4V5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',settings:'<path d="M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6"/>'};
const svg=name=>`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph[name]||glyph.volume}</svg>`;
function available() {return typeof window!=='undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;}
function voices() {try{return available()?window.speechSynthesis.getVoices():[];}catch{return [];}}
function setStatus(message) {if(player)player.querySelector('[data-audio-status]').textContent=message;}
function restoreOrigin() {
  if(!originButton)return;
  originButton.setAttribute('aria-pressed','false');originButton.setAttribute('aria-expanded','false');originButton.removeAttribute('aria-controls');
  originButton.innerHTML=originalButtonHTML;originButton=null;originalButtonHTML='';
}
function syncControls() {
  if(!player)return;
  const play=player.querySelector('[data-audio-play]');
  play.innerHTML=svg(playback==='playing'?'pause':'play')+`<span>${playback==='playing'?'Pause':playback==='paused'?'Resume':'Play'}</span>`;
  play.disabled=!available() || !selectedContent;
  player.querySelector('[data-audio-stop]').disabled=!['playing','paused'].includes(playback);
  player.querySelector('[data-audio-preview]').disabled=!available();
  if(originButton)originButton.setAttribute('aria-pressed',String(['playing','paused'].includes(playback)));
}
function stopCurrent(message='Ready when you are.') {
  token++;utterance=null;playback='idle';
  if(available())window.speechSynthesis.cancel();
  syncControls();setStatus(message);
}
export function stopSpeech() {
  stopCurrent();restoreOrigin();
  if(player)player.hidden=true;
}
function populateVoices() {
  if(!player)return;
  const select=player.querySelector('[data-audio-voice]');
  const list=voices();const saved=readAudioPreferences();select.replaceChildren();
  const auto=document.createElement('option');auto.value='';
  const recommended=chooseDefaultVoice(list);auto.textContent=recommended?`Recommended · ${recommended.name}`:'Recommended English voice';select.append(auto);
  list.slice().sort((a,b)=>(a.lang||'').localeCompare(b.lang||'') || a.name.localeCompare(b.name)).forEach(voice=>{
    const option=document.createElement('option');option.value=voice.voiceURI;option.textContent=`${voice.name} · ${voice.lang}`;select.append(option);
  });
  select.value=list.some(voice=>voice.voiceURI===saved.voiceURI)?saved.voiceURI:'';
  player.querySelector('[data-audio-availability]').textContent=!available()?'Audio isn’t supported in this browser.':!list.length?'Waiting for your browser’s voices. You can still try Play.':'Voices are provided by your browser and device. Availability and sound can vary.';
}
function ensurePlayer() {
  if(player)return player;
  player=document.createElement('section');player.id='audioPlayer';player.className='audio-player';player.setAttribute('aria-label','Reading audio player');player.hidden=true;
  player.innerHTML=`<div class="audio-player-heading"><span class="audio-player-mark" aria-hidden="true">${svg('volume')}</span><div><p>YOUR READING VOICE</p><h2 data-audio-title>Voice preferences</h2></div><button class="audio-close" type="button" data-audio-close aria-label="Close audio player">${svg('close')}</button></div><p class="audio-status" data-audio-status role="status">Ready when you are.</p><div class="audio-playback"><button class="audio-play" type="button" data-audio-play>${svg('play')}<span>Play</span></button><button class="audio-stop" type="button" data-audio-stop disabled>${svg('stop')}<span>Stop</span></button></div><details class="audio-preferences" data-audio-preferences><summary>${svg('settings')}Voice preferences</summary><div class="audio-preferences-body"><label class="audio-voice-label">Voice<select data-audio-voice aria-label="Reading voice"></select></label><label class="audio-range-label">Pace<output data-audio-rate-value></output><input data-audio-rate type="range" min="0.6" max="1.3" step="0.05" aria-label="Reading speed"></label><label class="audio-range-label">Pitch<output data-audio-pitch-value></output><input data-audio-pitch type="range" min="0.8" max="1.2" step="0.02" aria-label="Reading pitch"></label><button class="audio-preview" type="button" data-audio-preview>Preview this voice →</button><p class="audio-availability" data-audio-availability></p></div></details>`;
  document.body.append(player);
  player.querySelector('[data-audio-close]').addEventListener('click',()=>{const button=originButton;stopSpeech();if(button?.isConnected)button.focus();});
  player.querySelector('[data-audio-play]').addEventListener('click',()=>{
    if(playback==='playing'){window.speechSynthesis.pause();playback='paused';syncControls();setStatus('Paused. Resume whenever you’re ready.');}
    else if(playback==='paused'){window.speechSynthesis.resume();playback='playing';syncControls();setStatus('Reading aloud…');}
    else if(selectedContent)startReading(selectedContent);
  });
  player.querySelector('[data-audio-stop]').addEventListener('click',()=>stopCurrent('Stopped. Play starts from the beginning.'));
  player.querySelector('[data-audio-preview]').addEventListener('click',()=>startReading({title:'Voice preview',text:'Research begins with a question. Take your time, follow the ideas, and read at your own pace.'},true));
  player.querySelector('[data-audio-voice]').addEventListener('change',event=>{savePreferences({voiceURI:event.target.value});stopCurrent('Voice saved. Press Play to hear it.');});
  ['rate','pitch'].forEach(name=>{
    const input=player.querySelector(`[data-audio-${name}]`);
    input.addEventListener('input',()=>{savePreferences({[name]:Number(input.value)});updatePreferenceLabels();});
    input.addEventListener('change',()=>stopCurrent('Preferences saved. Press Play to hear the change.'));
  });
  if(available())window.speechSynthesis.addEventListener?.('voiceschanged',populateVoices);
  document.addEventListener('keydown',event=>{if(event.key==='Escape' && player && !player.hidden){const button=originButton;stopSpeech();if(button?.isConnected)button.focus();}});
  populateVoices();updatePreferenceLabels();syncControls();return player;
}
function updatePreferenceLabels() {
  if(!player)return;
  const pref=readAudioPreferences();
  player.querySelector('[data-audio-rate]').value=String(pref.rate);player.querySelector('[data-audio-pitch]').value=String(pref.pitch);
  player.querySelector('[data-audio-rate-value]').textContent=`${pref.rate.toFixed(2).replace(/0$/,'')}×`;
  player.querySelector('[data-audio-pitch-value]').textContent=pref.pitch.toFixed(2);
}
function startReading(content,preview=false) {
  stopCurrent();
  if(!available()){setStatus('Audio is unavailable in this browser. You can keep reading the text.');return;}
  const pref=readAudioPreferences();const list=voices();
  const voice=list.find(item=>item.voiceURI===pref.voiceURI) || chooseDefaultVoice(list);
  const current=token;
  utterance=new SpeechSynthesisUtterance(content.text);utterance.rate=pref.rate;utterance.pitch=pref.pitch;utterance.lang=voice?.lang || 'en-US';if(voice)utterance.voice=voice;
  playback='playing';syncControls();setStatus(preview?'Previewing your voice…':'Reading aloud…');
  utterance.onend=()=>{if(current!==token)return;utterance=null;playback='idle';syncControls();setStatus(preview?'Preview finished. Your preferences are saved.':'Finished reading.');};
  utterance.onerror=event=>{if(current!==token || ['canceled','interrupted'].includes(event.error))return;stopCurrent('This voice could not start. Try another voice or keep reading.');};
  try{window.speechSynthesis.speak(utterance);}catch{stopCurrent('This voice could not start. Try another voice.');}
}
export function listenToText(content,button,options={}) {
  if(typeof document==='undefined')return;
  const title=typeof content?.title==='string'?content.title:'Reading';
  const text=typeof content?.text==='string'?content.text.trim():'';
  ensurePlayer();
  if(originButton===button && !player.hidden){
    if(playback==='playing'){window.speechSynthesis.pause();playback='paused';setStatus('Paused. Resume whenever you’re ready.');syncControls();return;}
    if(playback==='paused'){window.speechSynthesis.resume();playback='playing';setStatus('Reading aloud…');syncControls();return;}
  }
  stopCurrent();restoreOrigin();selectedContent=text?{title,text}:null;
  if(button){originButton=button;originalButtonHTML=button.innerHTML;button.setAttribute('aria-expanded','true');button.setAttribute('aria-controls','audioPlayer');}
  player.querySelector('[data-audio-title]').textContent=title;player.hidden=false;
  if(typeof options.rate==='number')savePreferences({rate:options.rate});
  populateVoices();updatePreferenceLabels();syncControls();
  if(selectedContent && options.autoplay!==false)startReading(selectedContent);
  else setStatus(!available()?'Audio is unavailable in this browser. You can keep reading.':'Choose a voice, then press Play.');
}
export function listenToPaper(paper,button,rate) {
  listenToText({title:paper?.title || 'Paper abstract',text:[paper?.title,paper?.summary].filter(Boolean).join('. ')},button,{rate});
}
export function openAudioSettings() {
  if(typeof document==='undefined')return;
  ensurePlayer();player.hidden=false;player.querySelector('[data-audio-preferences]').open=true;
  if(!selectedContent)player.querySelector('[data-audio-title]').textContent='Make yourself a reading voice';
  populateVoices();updatePreferenceLabels();syncControls();player.querySelector('[data-audio-voice]').focus();
}
if(typeof window!=='undefined')window.addEventListener('pagehide',stopSpeech);
