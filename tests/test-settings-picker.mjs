import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {chooseSettings} from '../payload/model-catalog.mjs';
import {confirmFirstPrompt} from '../payload/confirm-first-prompt.mjs';

const models = [{model:'gpt-6.1-sol',displayName:'GPT-6.1 Sol',efforts:['low','high','ultra']},
  {model:'gpt-6-luna',displayName:'GPT-6 Luna',efforts:['low','medium','max']}];
test('two native cards use current catalog and only the chosen model efforts', async () => {
  const forms=[];
  const selected=await chooseSettings(async form=>{
    forms.push(form);
    return {action:'accept',content:forms.length===1?{model:'gpt-6-luna'}:{effort:'max'}};
  },'gpt-6.1-sol',async()=>models);
  assert.deepEqual(selected,{model:'gpt-6-luna',effort:'max'});
  assert.deepEqual(forms[1].requestedSchema.properties.effort.oneOf.map(e=>e.const),['low','medium','max']);
  assert.equal('default' in forms[0].requestedSchema.properties.model,false);
});
test('cancel or automatic accept without selection never produces settings',async()=>{
  assert.equal(await chooseSettings(async()=>({action:'cancel'}),'x',async()=>models),null);
  await assert.rejects(chooseSettings(async()=>({action:'accept',content:{}}),'x',async()=>models),/invalid_model/);
  let count=0;
  assert.equal(await chooseSettings(async()=>++count===1?{action:'accept',content:{model:'gpt-6-luna'}}:{action:'cancel'},'x',async()=>models),null);
});
test('unsupported model/effort combinations fail closed',async()=>{
  let count=0;
  await assert.rejects(chooseSettings(async()=>({action:'accept',content:++count===1?{model:'gpt-6-luna'}:{effort:'ultra'}}),'x',async()=>models),/invalid_effort/);
});
const root=mkdtempSync(join(tmpdir(),'model-guard-settings-'));
const state=id=>join(root,createHash('sha256').update(id).digest('hex')+'.txt');
const input=id=>({session_id:id,hook_event_name:'UserPromptSubmit',model:'gpt-6.1-sol',prompt:'`질문`  \r\n다음 줄\n'});
test('selection passes exact original and one-use grant to recovery, while original turn stays blocked',async()=>{
  const id='chosen';writeFileSync(state(id),'armed');let queued;
  const result=await confirmFirstPrompt(input(id),async()=>({action:'accept',content:{decision:'change'}}),root,async(...args)=>{queued=args;return true;},async()=>({windowId:12}),async()=>({model:'gpt-6-luna',effort:'max'}));
  assert.equal(result.decision,'block');assert.equal(queued[0],input(id).prompt);
  assert.deepEqual(queued[2].selection,{model:'gpt-6-luna',effort:'max'});
  assert.equal(queued[2].grant.path,state(id));assert.equal(readFileSync(state(id),'utf8'),'armed');
});
test('picker cancel restores original without opening model menu or sending',async()=>{
  const id='cancelled';writeFileSync(state(id),'armed');let options;
  const result=await confirmFirstPrompt(input(id),async()=>({action:'accept',content:{decision:'change'}}),root,async(_,__,o)=>{options=o;return true;},async()=>({windowId:12}),async()=>null);
  assert.equal(result.decision,'block');assert.deepEqual(options,{restoreOnly:true});
});
test('Stop while a selection card is open never schedules automation',async()=>{
  const id='stopped';writeFileSync(state(id),'armed');
  let calls=0;
  const result=await confirmFirstPrompt(input(id),async()=>({action:'accept',content:{decision:'change'}}),root,()=>{calls++;return true;},async()=>({windowId:12}),async()=>{throw Error('Confirmation cancelled');});
  assert.equal(calls,0);assert.equal(result.decision,'block');assert.equal(readFileSync(state(id),'utf8'),'armed');
});
test('one-use grant accepts only matching prompt/model within expiry',async()=>{
  const id='retry',value=input(id);
  const grant={kind:'selected-submit',model:'gpt-6-luna',effort:'max',expiresAt:Date.now()+15000,
    promptHash:createHash('sha256').update(value.prompt.replace(/\r\n?/g,'\n').replace(/\n+$/,'')).digest('hex')};
  writeFileSync(state(id),JSON.stringify(grant));
  assert.deepEqual(await confirmFirstPrompt({...value,model:'gpt-6-luna'},()=>{throw Error('must not ask')},root),{});
  assert.equal(readFileSync(state(id),'utf8'),'confirmed');
  for(const patch of [{model:'gpt-6.1-sol'},{prompt:'different'},{}]){
    writeFileSync(state(id),JSON.stringify({...grant,...(!Object.keys(patch).length?{expiresAt:0}:{})}));
    let asked=false;
    const result=await confirmFirstPrompt({...value,model:'gpt-6-luna',...patch},async()=>{asked=true;return {action:'decline'};},root,async()=>false);
    assert.equal(asked,true);assert.equal(result.decision,'block');
  }
});
