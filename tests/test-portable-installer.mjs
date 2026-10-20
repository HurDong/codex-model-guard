import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {install,openCli,mergeHooks,checkPayload,discoverRuntimes} from '../installer.mjs';

const root=path.resolve(import.meta.dirname,'..');
const {cli,powershell}=discoverRuntimes();
const sha=text=>createHash('sha256').update(text).digest('hex');
const fresh=()=>{
  const temp=fs.mkdtempSync(path.join(tmpdir(),'codex-portable-install-'));
  const home=path.join(temp,'다른 사용자 이름','Codex 홈');fs.mkdirSync(home,{recursive:true});return home;
};
const options=home=>({root,home,cli,powershell,approve:async()=>true,log:()=>{}});

test('export contains only portable code and user-facing copy',()=>{
  const manifest=checkPayload(root);assert.equal(manifest.files.length,13);
  assert.ok(manifest.files.every(f=>!/(?:cache|status|installation|auth|state|catalog\.json)/i.test(f.name)));
  for(const file of manifest.files){
    const source=fs.readFileSync(path.join(root,'payload',file.name),'utf8');
    assert.doesNotMatch(source,/C:[\\/]Users[\\/]original-test-user/i);
  }
});

test('real CLI installs in a Unicode/spaced home, preserves unrelated settings, and is idempotent',async()=>{
  const home=fresh();
  const initial='# KEEP COMMENT\nmodel = "gpt-6.1-sol"\napproval_policy = "on-request"\n[mcp_servers.keep_me]\ncommand = "where.exe"\nenabled = false\n';
  fs.writeFileSync(path.join(home,'config.toml'),initial);
  const other={description:'preserve me',hooks:{SessionStart:[{matcher:'^resume$',hooks:[{type:'command',command:'echo unrelated'}]}],
    PostToolUse:[{hooks:[{type:'command',command:'echo keep post'}]}]}};
  fs.writeFileSync(path.join(home,'hooks.json'),JSON.stringify(other));
  const first=await install(options(home));assert.equal(first.installed,true);
  const backup=fs.readFileSync(path.join(first.backupDir,'config.toml.before'),'utf8');assert.equal(backup,initial);
  let actual=JSON.parse(fs.readFileSync(path.join(home,'hooks.json')));
  assert.deepEqual(actual.hooks.PostToolUse,other.hooks.PostToolUse);
  assert.deepEqual(actual.hooks.SessionStart[0],other.hooks.SessionStart[0]);
  assert.equal(actual.hooks.SessionStart.length,2);assert.equal(actual.hooks.UserPromptSubmit.length,1);
  await install(options(home));
  actual=JSON.parse(fs.readFileSync(path.join(home,'hooks.json')));
  assert.equal(actual.hooks.SessionStart.length,2);assert.equal(actual.hooks.UserPromptSubmit.length,1);
  let inference=0,forms=0,completed=false;
  const provider=createServer((_req,res)=>{inference++;res.writeHead(500);res.end('Unexpected inference in installer test');});
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  const notifications=[];
  const rpc=openCli(cli,home,{onRequest:(item,reply)=>{
    if(item.method==='mcpServer/elicitation/request'){forms++;reply({action:'cancel',content:null});}
  },onNotification:item=>{if(item.method==='turn/completed')completed=true;if(item.method==='hook/completed')notifications.push(item.params);}});
  try{
    await rpc.initialize();
    const config=(await rpc.request('config/read',{includeLayers:false})).config;
    assert.equal(config.model,'gpt-6.1-sol');assert.equal(config.approval_policy,'on-request');
    assert.equal(config.mcp_servers.keep_me.command,'where.exe');assert.equal(config.mcp_servers.keep_me.enabled,false);
    assert.ok(config.mcp_servers.first_prompt_confirm.env_vars.includes('CODEX_APP_TOOLS_PIPE_PATH'));
    assert.equal(config.mcp_servers.first_prompt_confirm.env.CODEX_FIRST_PROMPT_PWSH_PATH,powershell);
    const listed=(await rpc.request('hooks/list',{cwds:[home]})).data.flatMap(d=>d.hooks);
    assert.equal(listed.filter(h=>first.hookKeys.includes(h.key)&&h.trustStatus==='trusted').length,2);
    assert.ok(listed.some(h=>h.eventName==='postToolUse'&&h.trustStatus!=='trusted'));
    const start=await rpc.request('thread/start',{cwd:home,ephemeral:true,model:'gpt-6.1-sol',modelProvider:'installer_test',config:{
      'model_providers.installer_test':{name:'Local installer test',base_url:`http://127.0.0.1:${provider.address().port}`,wire_api:'responses',requires_openai_auth:false,request_max_retries:0,stream_max_retries:0}
    }});
    const state=path.join(first.target,'state',sha(start.thread.id)+'.txt');
    await rpc.request('turn/start',{threadId:start.thread.id,input:[{type:'text',text:'LOCAL_INSTALLER_NO_INFERENCE_TEST'}]});
    const deadline=Date.now()+6000;
    while(!completed&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
    assert.equal(fs.existsSync(state),true,'actual SessionStart hook must arm even with spaces/non-ASCII in path: '+JSON.stringify(notifications));
    assert.equal(fs.readFileSync(state,'utf8'),'armed');
    assert.equal(forms,1,'native first-choice card must appear');assert.equal(completed,true);assert.equal(inference,0);
  }finally{rpc.close();provider.closeAllConnections();provider.close();}
  console.log('Verified isolated install: '+home);
});

test('fresh install works with no existing config or hooks',async()=>{
  const home=fresh(),result=await install(options(home));assert.equal(result.installed,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'hooks.json'))).hooks.SessionStart.length,1);
});

test('installer rollback restores original config/hooks after a failed commit',async()=>{
  const home=fresh(),config='model = "gpt-6.1-sol"\n',hooks='{"hooks":{},"description":"keep exact"}';
  fs.writeFileSync(path.join(home,'config.toml'),config);fs.writeFileSync(path.join(home,'hooks.json'),hooks);
  await assert.rejects(install({...options(home),afterConfig:()=>{throw Error('intentional test failure');}}),/intentional test failure/);
  assert.equal(fs.readFileSync(path.join(home,'config.toml'),'utf8'),config);
  assert.equal(fs.readFileSync(path.join(home,'hooks.json'),'utf8'),hooks);
  assert.equal(fs.existsSync(path.join(home,'hooks','first-prompt-confirm','confirm-first-prompt.mjs')),false);
  assert.equal(fs.existsSync(path.join(home,'.first-prompt-install.lock')),false);
});

test('malformed existing hooks are rejected without any settings changes',async()=>{
  const home=fresh();fs.writeFileSync(path.join(home,'hooks.json'),'{broken');
  await assert.rejects(install(options(home)));
  assert.equal(fs.readFileSync(path.join(home,'hooks.json'),'utf8'),'{broken');
  assert.equal(fs.existsSync(path.join(home,'config.toml')),false);
});

test('recipient declining consent makes no registration changes',async()=>{
  const home=fresh();const result=await install({...options(home),approve:async()=>false});
  assert.deepEqual(result,{cancelled:true});assert.equal(fs.existsSync(path.join(home,'config.toml')),false);
});

test('tampered runtime payload is rejected before install',async()=>{
  const bad=fresh();fs.mkdirSync(path.join(bad,'payload'));
  const manifest=checkPayload(root);fs.copyFileSync(path.join(root,'manifest.json'),path.join(bad,'manifest.json'));
  for(const entry of manifest.files)fs.copyFileSync(path.join(root,'payload',entry.name),path.join(bad,'payload',entry.name));
  fs.appendFileSync(path.join(bad,'payload',manifest.files[0].name),'\nchanged');
  assert.throws(()=>checkPayload(bad),/변경/);
});

test('packaged MCP boots and exposes the manifest version without requesting inference',async()=>{
  const child=spawn(process.execPath,[path.join(root,'payload','confirm-first-prompt.mjs')],{windowsHide:true,stdio:['pipe','pipe','ignore']});
  try{
    const answer=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('MCP init timeout')),3000);
      createInterface({input:child.stdout}).on('line',line=>{const x=JSON.parse(line);if(x.id===1){clearTimeout(timer);resolve(x);}});
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{capabilities:{elicitation:{form:{}}}}})+'\n');
    });
    assert.equal(answer.result.serverInfo.version,checkPayload(root).version);
  }finally{child.kill();}
});

test('actual double-click CMD launcher installs with runtime discovery and one Y confirmation',async()=>{
  const home=fresh(),packageDir=path.join(path.dirname(home),'팀즈 받은 설치 파일');
  fs.mkdirSync(packageDir);fs.mkdirSync(path.join(packageDir,'payload'));
  for(const name of ['설치.cmd','설정.cmd','installer.mjs','manifest.json','먼저 읽기.txt'])fs.copyFileSync(path.join(root,name),path.join(packageDir,name));
  for(const entry of checkPayload(root).files)fs.copyFileSync(path.join(root,'payload',entry.name),path.join(packageDir,'payload',entry.name));
  const child=spawn('cmd.exe',['/d','/s','/c',`""${path.join(packageDir,'설치.cmd')}""`],{
    windowsHide:true,windowsVerbatimArguments:true,stdio:['pipe','pipe','pipe'],env:{...process.env,CODEX_HOME:home}
  });
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.stdin.on('error',()=>{});
  child.stdin.end('Y\r\n\r\n');
  const exit=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(Error('CMD launcher timed out: '+output));},10000);
    child.on('exit',code=>{clearTimeout(timer);resolve(code);});child.on('error',reject);
  });
  assert.equal(exit,0,output);
  assert.ok(fs.existsSync(path.join(home,'hooks','first-prompt-confirm','installation.json')),output);
});

test('real CLI withdraws an unanswered card after ten seconds and continues the original request once',async()=>{
  const home=fresh();await install(options(home));
  const requests=[],notifications=[];let formAt=0,forms=0,completed=false;
  const provider=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    const message={id:'msg_timeout',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'LOCAL_TIMEOUT_OK',annotations:[]}]};
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const events=[{type:'response.output_item.done',output_index:0,item:message},
      {type:'response.completed',response:{id:'resp_timeout',object:'response',status:'completed',model:'gpt-6.1-sol',output:[message],usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}}];
    for(const [sequence_number,event]of events.entries())res.write(`event: ${event.type}\ndata: ${JSON.stringify({sequence_number,...event})}\n\n`);
    res.end();
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  const rpc=openCli(cli,home,{onRequest:item=>{
    if(item.method==='mcpServer/elicitation/request'){formAt=Date.now();forms++;}
  },onNotification:item=>{notifications.push(item);if(item.method==='turn/completed')completed=true;}});
  try{
    await rpc.initialize();
    const start=await rpc.request('thread/start',{cwd:home,ephemeral:true,model:'gpt-6.1-sol',modelProvider:'timeout_test',config:{
      'model_providers.timeout_test':{name:'Local timeout test',base_url:`http://127.0.0.1:${provider.address().port}`,wire_api:'responses',requires_openai_auth:false,request_max_retries:0,stream_max_retries:0}
    }});
    await rpc.request('turn/start',{threadId:start.thread.id,effort:'high',input:[{type:'text',text:'LOCAL_TIMEOUT_ORIGINAL_TEXT'}]});
    const deadline=Date.now()+16000;
    while(!completed&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
    assert.equal(forms,1);assert.equal(completed,true,JSON.stringify(notifications.map(n=>n.method)));
    assert.equal(requests.length,1,'one original request proceeds after timeout');
    assert.ok(Date.now()-formAt>=9500,'must not proceed before the ten-second deadline');
    assert.equal(requests[0].model,'gpt-6.1-sol');assert.equal(requests[0].reasoning.effort,'high');
    assert.match(JSON.stringify(requests[0].input),/LOCAL_TIMEOUT_ORIGINAL_TEXT/);
    assert.ok(notifications.some(n=>n.method==='serverRequest/resolved'),'native outstanding request must be removed');
    assert.equal(fs.readFileSync(path.join(home,'hooks','first-prompt-confirm','state',sha(start.thread.id)+'.txt'),'utf8'),'confirmed');
  }finally{rpc.close();provider.closeAllConnections();provider.close();}
});

test('settings CMD works from both installed and source folders and reinstall preserves the switches',async()=>{
  const home=fresh(),installed=await install(options(home));
  const file=path.join(installed.target,'settings.json');
  async function run(launcher,answers){
    const child=spawn('cmd.exe',['/d','/s','/c',`""${launcher}""`],{
      windowsHide:true,windowsVerbatimArguments:true,stdio:['pipe','pipe','pipe'],env:{...process.env,CODEX_HOME:home}
    });
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.stdin.on('error',()=>{});
    const exit=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(Error('Settings CMD timeout: '+output));},5000);
      child.on('exit',code=>{clearTimeout(timer);resolve(code);});child.on('error',reject);
      child.stdin.end(answers);
    });
    assert.equal(exit,0,output);assert.match(output,/첫 설정 확인/);return output;
  }
  await run(path.join(installed.target,'설정.cmd'),'1\r\n2\r\n0\r\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)),{enabled:false,autoContinue:false});
  await run(path.join(root,'설정.cmd'),'1\r\n0\r\n');
  const saved=fs.readFileSync(file,'utf8');assert.deepEqual(JSON.parse(saved),{enabled:true,autoContinue:false});
  await install(options(home));assert.equal(fs.readFileSync(file,'utf8'),saved);
});
