import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {readSettings,toggleSetting} from '../payload/guard-settings.mjs';
import {confirmFirstPrompt} from '../payload/confirm-first-prompt.mjs';

const fixture=()=>{
  const root=fs.mkdtempSync(path.join(tmpdir(),'guard-settings-test-'));
  return {root,file:path.join(root,'settings.json')};
};
const input=id=>({session_id:id,hook_event_name:'UserPromptSubmit',model:'gpt-6.1-sol'});
const state=(root,id)=>path.join(root,createHash('sha256').update(id).digest('hex')+'.txt');
const never=()=>{throw Error('Unexpected confirmation or recovery');};

test('two switches persist independently and preserve other settings',()=>{
  const {file}=fixture();
  assert.deepEqual(readSettings(file),{enabled:true,autoContinue:true});
  assert.deepEqual(toggleSetting(file,'enabled'),{enabled:false,autoContinue:true});
  assert.deepEqual(toggleSetting(file,'autoContinue'),{enabled:false,autoContinue:false});
  const stored=JSON.parse(fs.readFileSync(file));stored.futureOption='keep';fs.writeFileSync(file,JSON.stringify(stored));
  assert.deepEqual(toggleSetting(file,'enabled'),{enabled:true,autoContinue:false});
  assert.equal(JSON.parse(fs.readFileSync(file)).futureOption,'keep');
});

test('invalid configuration is not overwritten or treated as auto-accept enabled',()=>{
  const {file}=fixture();
  for(const text of ['{broken','{"enabled":"false"}','{"autoContinue":0}']){
    fs.writeFileSync(file,text);
    assert.throws(()=>readSettings(file));assert.throws(()=>toggleSetting(file,'enabled'));
    assert.equal(fs.readFileSync(file,'utf8'),text);
  }
});

test('workflow OFF bypasses the card and re-enabling does not interrupt the same chat later',async()=>{
  const {root,file}=fixture(),id='workflow-off';
  fs.writeFileSync(state(root,id),'armed');toggleSetting(file,'enabled');
  assert.deepEqual(await confirmFirstPrompt(input(id),never,root,never,never,never,{settingsPath:file}),{});
  assert.equal(fs.readFileSync(state(root,id),'utf8'),'confirmed');
  toggleSetting(file,'enabled');
  assert.deepEqual(await confirmFirstPrompt(input(id),never,root,never,never,never,{settingsPath:file}),{});
});

test('auto-continue OFF waits for explicit choice and settings changes are read without restarting',async()=>{
  const {root,file}=fixture(),id='auto-off';toggleSetting(file,'autoContinue');
  fs.writeFileSync(state(root,id),'armed');let respond,finished=false;
  const waiting=confirmFirstPrompt(input(id),(form)=>{
    assert.doesNotMatch(form.message,/10초 후/);
    return new Promise(resolve=>{respond=resolve;});
  },root,never,undefined,never,{settingsPath:file,timeoutMs:15}).then(value=>{finished=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(finished,false);
  respond({action:'accept',content:{decision:'correct'}});assert.deepEqual(await waiting,{});
  toggleSetting(file,'autoContinue');
  fs.writeFileSync(state(root,'auto-on'),'armed');
  assert.deepEqual(await confirmFirstPrompt(input('auto-on'),()=>new Promise(()=>{}),root,never,undefined,never,{settingsPath:file,timeoutMs:15}),{});
});
