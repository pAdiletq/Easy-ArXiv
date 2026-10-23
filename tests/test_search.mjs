import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../static/js/search-ui.js',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace(/^export /gm,'');
const context=vm.createContext({});
vm.runInContext(source+'\nthis.api={researchTopics,chooseTopics,localSuggestions};',context);
const {researchTopics,chooseTopics,localSuggestions}=context.api;
test('rotating examples are three distinct research topics and exclude the previous batch',()=>{
  let previous=[];
  for(let i=0;i<20;i++){
    const next=Array.from(chooseTopics(previous));
    assert.equal(next.length,3);assert.equal(new Set(next).size,3);
    assert.ok(next.every(topic=>researchTopics.includes(topic)&&!previous.includes(topic)));
    previous=next;
  }
});
test('autocomplete finds research terms case-insensitively but waits for two characters',()=>{
  assert.equal(localSuggestions('q').length,0);
  const matches=Array.from(localSuggestions(' QuAnTuM '));
  assert.ok(matches.length>0);assert.ok(matches.every(item=>item.type==='topic'&&item.label.toLowerCase().includes('quantum')));
  assert.ok(localSuggestions('Ar').some(item=>item.label==='Artificial intelligence'));
});
test('paper suggestions open the matching paper identifier, with authors as supporting information',()=>{
  const matches=localSuggestions('attention',[{id:'1706.03762v7',title:'Attention Is All You Need',authors:['Ashish Vaswani','Noam Shazeer','Niki Parmar']}]);
  assert.equal(matches[0].type,'paper');assert.equal(matches[0].value,'1706.03762v7');assert.equal(matches[0].authors,'Ashish Vaswani, Noam Shazeer');
  assert.equal(localSuggestions('nonexistent scientific topic').length,0);
});
