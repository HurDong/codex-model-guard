import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { hash, inspectOriginal, prepareBackground, submitBackground } from '../payload/background-submit.mjs';
import { AppToolsClient } from '../payload/app-tools-client.mjs';

const tools = [
  {namespace:'codex_app',name:'read_thread'},
  {namespace:'codex_app',name:'send_message_to_thread',inputSchema:{properties:{model:{type:'string'},thinking:{enum:['low','high']}}}}
];
const id='00000000-0000-4000-8000-000000000001';
const prompt='`원문` <tag> & 한글\n두 번째 줄';
const input={session_id:id,prompt};
function snapshot(status='completed',patch={}) {
  return {thread:{id,kind:'codex',hostId:'local',status:{type:status==='inProgress'?'active':'idle'}},
    turns:[{id:'turn-source',status,items:[{type:'userMessage',content:[{type:'text',text:prompt}]}],...patch}]};
}
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'codex-background-test-'));mkdirSync(join(dir,'state'));
  const path=join(dir,'state',hash(id)+'.txt');writeFileSync(path,'armed');
  const binding={mode:'app-pipe',threadId:id,turnId:'turn-source',promptHash:hash(prompt)};
  const selection={model:'gpt-6-luna',effort:'low'};
  return {dir,path,job:{input,binding,selection,grant:{path,...selection,promptHash:hash(prompt)}}};
}
function clientFor(read) {
  const sent=[];
  return {sent,listTools:async()=>tools,readThread:async()=>read(),send:async(...args)=>{sent.push(args);return {threadId:id};}};
}
test('source binding validates same local thread, exact text, and attachments',()=>{
  assert.equal(inspectOriginal(snapshot(),input).id,'turn-source');
  assert.throws(()=>inspectOriginal({...snapshot(),thread:{id:'other'}},input),/target_thread_mismatch/);
  const attached=snapshot();attached.turns[0].items[0].content.push({type:'image',url:'redacted'});
  assert.throws(()=>inspectOriginal(attached,input),/attachments_require_original_send/);
  assert.throws(()=>inspectOriginal(snapshot(),{...input,prompt:'different'}),/source_prompt_changed/);
});
test('preflight reads catalog and binds original turn without any mutation',async()=>{
  const client=clientFor(()=>snapshot('inProgress'));
  const binding=await prepareBackground(input,client);
  assert.equal(binding.turnId,'turn-source');assert.equal(client.sent.length,0);
  const unavailable=await prepareBackground(input,{listTools:async()=>[]});
  assert.equal(unavailable.mode,'unavailable');
});
test('blocked hook text binds to its empty active turn, never an older empty turn',async()=>{
  const client=clientFor(()=>snapshot('inProgress',{items:[]}));
  const binding=await prepareBackground(input,client);
  assert.equal(binding.promptSource,'hook');
  assert.equal(binding.turnId,'turn-source');
  const {dir,job}=fixture();job.binding=binding;
  client.readThread=async()=>snapshot('completed',{items:[]});
  assert.deepEqual(await submitBackground(job,{client,baseDir:dir}),{submitted:true});
  const stale=await prepareBackground(input,client);
  assert.equal(stale.mode,'unavailable');
});
test('waits for blocked original to finish, then changes only chosen session and sends exactly once',async()=>{
  const {dir,path,job}=fixture();let reads=0;
  const client=clientFor(()=>snapshot(++reads<3?'inProgress':'completed'));
  const result=await submitBackground(job,{client,baseDir:dir,sleep:async()=>{}});
  assert.deepEqual(result,{submitted:true});
  assert.deepEqual(client.sent,[[id,prompt,job.selection,'turn-source']]);
  assert.equal(readFileSync(path,'utf8'),'confirmed');
  assert.equal(existsSync(join(dir,'background',hash(id),'unsent.json')),false);
  assert.equal(existsSync(join(dir,'background',hash(id),'submit.lock')),false);
});
for (const [name,read,code] of [
  ['new request arrives',()=>snapshot('completed',{id:'different-turn'}),'source_turn_changed'],
  ['user stops original',()=>snapshot('interrupted'),'source_turn_cancelled'],
  ['original already answered',()=>snapshot('completed',{items:[...snapshot().turns[0].items,{type:'agentMessage',text:'done'}]}),'source_already_answered'],
  ['original fails',()=>snapshot('completed',{error:{message:'failed'}}),'source_turn_cancelled']
]) test(name+' never changes settings or sends',async()=>{
  const {dir,path,job}=fixture(),client=clientFor(read);
  const result=await submitBackground(job,{client,baseDir:dir});
  assert.equal(result.submitted,false);assert.equal(client.sent.length,0);
  assert.equal(readFileSync(path,'utf8'),'armed');
  const folder=join(dir,'background',hash(id));
  assert.equal(JSON.parse(readFileSync(join(folder,'status.json'))).status,code);
  assert.equal(JSON.parse(readFileSync(join(folder,'unsent.json'))).prompt,prompt);
});
test('bounded wait times out without mutation',async()=>{
  const {dir,job}=fixture(),client=clientFor(()=>snapshot('inProgress'));let clock=0;
  const r=await submitBackground(job,{client,baseDir:dir,now:()=>clock,sleep:async()=>{clock+=200;},timeoutMs:400});
  assert.equal(r.submitted,false);assert.equal(client.sent.length,0);
});
test('new source during final re-read is never sent',async()=>{
  const {dir,job}=fixture();let calls=0;
  const client=clientFor(()=>snapshot('completed',++calls===2?{id:'new'}:{}));
  const r=await submitBackground(job,{client,baseDir:dir});
  assert.equal(r.submitted,false);assert.equal(client.sent.length,0);
});
test('unknown send outcome retains a lock and prompt and never automatically retries',async()=>{
  const {dir,job}=fixture(),client=clientFor(()=>snapshot());
  client.send=async(...args)=>{client.sent.push(args);throw Error('app_pipe_timeout');};
  const r=await submitBackground(job,{client,baseDir:dir});
  assert.equal(r.uncertain,true);assert.equal(client.sent.length,1);
  await assert.rejects(submitBackground(job,{client,baseDir:dir}),/EEXIST/);
  assert.equal(client.sent.length,1);
});
test('cross-thread and forged grants are rejected before app calls',async()=>{
  const {dir,job}=fixture(),client=clientFor(()=>snapshot());
  await assert.rejects(submitBackground({...job,binding:{...job.binding,threadId:'other'}},{client,baseDir:dir}),/invalid_background_job/);
  assert.equal(client.sent.length,0);
});
test('real native framing, fragmented responses, same-thread metadata, and exact selected settings',async()=>{
  const path=process.platform==='win32'?`\\\\.\\pipe\\codex-background-test-${randomUUID()}`:join(tmpdir(),`codex-test-${randomUUID()}.sock`);
  const requests=[];
  const server=net.createServer(socket=>{
    let buf=Buffer.alloc(0);
    socket.on('error',()=>{});
    socket.on('data',chunk=>{
      buf=Buffer.concat([buf,chunk]);if(buf.length<4||buf.length<4+buf.readUInt32LE(0))return;
      const request=JSON.parse(buf.subarray(4,4+buf.readUInt32LE(0)));requests.push(request);
      const result=request.method==='tools/list'?{tools}:{success:true,contentItems:[{type:'inputText',text:JSON.stringify({threadId:id})}]};
      const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:request.id,result})),head=Buffer.alloc(4);head.writeUInt32LE(body.length);
      const frame=Buffer.concat([head,body]);socket.write(frame.subarray(0,3));setImmediate(()=>socket.end(frame.subarray(3)));
    });
  });
  await new Promise(r=>server.listen(path,r));
  try {
    const c=new AppToolsClient(path,1000);assert.equal((await c.listTools()).length,2);
    assert.deepEqual(await c.send(id,prompt,{model:'gpt-6-luna',effort:'low'}),{threadId:id});
    assert.equal(requests[1].params.threadId,id);
    assert.deepEqual(requests[1].params.arguments,{threadId:id,hostId:'local',prompt,model:'gpt-6-luna',thinking:'low'});
    await assert.rejects(c.callForThread(id,'send_message_to_thread',{threadId:'other'}),/target_thread_mismatch/);
  } finally { await new Promise(r=>server.close(r)); }
});
