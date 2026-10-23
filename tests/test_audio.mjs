import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {Element,plain} from './helpers/core-harness.mjs';
const source=fs.readFileSync(new URL('../static/js/audio.js',import.meta.url),'utf8').replace(/^export /gm,'');
const baseVoices=[{name:'English local',lang:'en-GB',voiceURI:'local',default:true},{name:'Microsoft Aria Online (Natural)',lang:'en-US',voiceURI:'aria'},{name:'Français',lang:'fr-FR',voiceURI:'fr'}];
function audioHarness({supported=true,voices=baseVoices,stored=null,blocked=false}={}){
  const body=new Element('body'),document=new Element('document');document.body=body;document.createElement=tag=>new Element(tag);
  const window=new Element('window');const spoken=[],events=new Map();let cancelled=0,paused=0,resumed=0;
  const speech={getVoices:()=>voices,speak:value=>spoken.push(value),cancel:()=>cancelled++,pause:()=>paused++,resume:()=>resumed++,addEventListener:(name,fn)=>events.set(name,fn)};
  class Utterance{constructor(text){this.text=text;}}
  if(supported){window.speechSynthesis=speech;window.SpeechSynthesisUtterance=Utterance;}
  const writes=[];const localStorage={getItem:()=>{if(blocked)throw Error('blocked');return stored?JSON.stringify(stored):null;},setItem:(key,value)=>{if(blocked)throw Error('blocked');writes.push([key,JSON.parse(value)]);}};
  const context=vm.createContext({document,window,localStorage,SpeechSynthesisUtterance:Utterance});
  vm.runInContext(source+'\nthis.api={normalizeAudioPreferences,chooseDefaultVoice,readAudioPreferences,listenToPaper,listenToText,stopSpeech,openAudioSettings};',context);
  const player=()=>body.children.find(item=>item.id==='audioPlayer');
  return{api:context.api,document,window,spoken,writes,events,player,counters:()=>({cancelled,paused,resumed})};
}
test('audio preferences use a slower gentle default and bound malformed stored values',()=>{
  const h=audioHarness();assert.deepEqual(plain(h.api.readAudioPreferences()),{voiceURI:'',rate:.9,pitch:1.02});
  assert.deepEqual(plain(h.api.normalizeAudioPreferences({voiceURI:'x'.repeat(600),rate:99,pitch:0})),{voiceURI:'x'.repeat(500),rate:1.3,pitch:.8});
  assert.deepEqual(plain(h.api.normalizeAudioPreferences({rate:NaN,pitch:'bad'})),{voiceURI:'',rate:.9,pitch:1.02});
});
test('recommended voice prefers an available natural English voice without inventing a voice',()=>{
  const h=audioHarness();assert.equal(h.api.chooseDefaultVoice(baseVoices).voiceURI,'aria');assert.equal(h.api.chooseDefaultVoice([]),null);assert.equal(h.api.chooseDefaultVoice([{name:'Local default',lang:'de-DE',voiceURI:'de',default:true}]).voiceURI,'de');
  assert.equal(h.api.chooseDefaultVoice([{name:'Microsoft David',lang:'en-US',voiceURI:'david',default:true},{name:'Microsoft Zira',lang:'en-US',voiceURI:'zira'}]).voiceURI,'zira');
});
test('listening uses persisted voice, pace and pitch and exposes pause, resume and stop',async()=>{
  const h=audioHarness({stored:{voiceURI:'local',rate:.8,pitch:.94}}),button=new Element('button');button.innerHTML='Listen to abstract';
  h.api.listenToPaper({title:'A paper',summary:'Its abstract.'},button);assert.equal(h.spoken.length,1);assert.equal(h.spoken[0].text,'A paper. Its abstract.');assert.equal(h.spoken[0].voice.voiceURI,'local');assert.equal(h.spoken[0].rate,.8);assert.equal(h.spoken[0].pitch,.94);assert.equal(button.getAttribute('aria-pressed'),'true');
  await h.player().querySelector('[data-audio-play]').emit('click');assert.equal(h.counters().paused,1);await h.player().querySelector('[data-audio-play]').emit('click');assert.equal(h.counters().resumed,1);
  h.api.stopSpeech();assert.equal(button.getAttribute('aria-pressed'),'false');assert.equal(button.innerHTML,'Listen to abstract');assert.equal(h.player().hidden,true);
});
test('a changed preference is persisted, previewable and does not restart a paper automatically',async()=>{
  const h=audioHarness();h.api.openAudioSettings();assert.equal(h.spoken.length,0);assert.equal(h.player().querySelector('[data-audio-preferences]').open,true);
  const rate=h.player().querySelector('[data-audio-rate]');rate.value='0.75';await rate.emit('input');await rate.emit('change');assert.equal(h.writes.at(-1)[1].rate,.75);assert.equal(h.spoken.length,0);
  const voice=h.player().querySelector('[data-audio-voice]');voice.value='local';await voice.emit('change');await h.player().querySelector('[data-audio-preview]').emit('click');assert.equal(h.spoken.length,1);assert.equal(h.spoken[0].voice.voiceURI,'local');assert.match(h.spoken[0].text,/Research begins/);assert.equal(h.spoken[0].rate,.75);
});
test('an outdated speech completion cannot stop a later paper or change its controls',()=>{
  const h=audioHarness(),first=new Element('button'),second=new Element('button');h.api.listenToText({title:'First',text:'First idea.'},first);const previous=h.spoken[0];h.api.listenToText({title:'Second',text:'Second idea.'},second);previous.onend();assert.equal(second.getAttribute('aria-pressed'),'true');assert.equal(h.player().querySelector('[data-audio-status]').textContent,'Reading aloud…');assert.equal(first.getAttribute('aria-pressed'),'false');h.spoken[1].onend();assert.equal(second.getAttribute('aria-pressed'),'false');assert.equal(h.player().querySelector('[data-audio-status]').textContent,'Finished reading.');
});
test('blocked storage and missing speech support still provide an honest usable panel',()=>{
  const h=audioHarness({supported:false,blocked:true});h.api.listenToText({title:'Paper',text:'Readable text.'},new Element('button'));assert.equal(h.player().hidden,false);assert.equal(h.player().querySelector('[data-audio-play]').disabled,true);assert.match(h.player().querySelector('[data-audio-availability]').textContent,/isn’t supported/);assert.deepEqual(plain(h.api.readAudioPreferences()),{voiceURI:'',rate:.9,pitch:1.02});
});
test('close and Escape stop speech and restore focus to the initiating listen button',async()=>{
  const h=audioHarness(),button=new Element('button');h.api.listenToText({title:'Paper',text:'An idea.'},button);await h.player().querySelector('[data-audio-close]').emit('click');assert.equal(h.player().hidden,true);assert.equal(button.focusCount,1);h.api.listenToText({title:'Paper',text:'An idea.'},button);await h.document.emit('keydown',{key:'Escape'});assert.equal(h.player().hidden,true);assert.equal(button.focusCount,2);
});
