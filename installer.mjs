import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createInterface as questionInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const bytesHash = file => fs.existsSync(file) ? digest(fs.readFileSync(file)) : null;
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
const normalized = value => value.replaceAll('\\','/').toLowerCase();
const withoutNulls = value => Array.isArray(value) ? value.filter(v=>v!==null).map(withoutNulls)
  : value&&typeof value==='object' ? Object.fromEntries(Object.entries(value).filter(([,v])=>v!==null).map(([k,v])=>[k,withoutNulls(v)])) : value;

export function discoverRuntimes(env=process.env) {
  const profile=env.USERPROFILE;
  if(!profile||!env.LOCALAPPDATA)throw Error('Windows 사용자 경로를 확인하지 못했습니다.');
  const executable = value => value&&fs.existsSync(value)&&fs.statSync(value).isFile();
  const which = name => {
    const r=spawnSync('where.exe',[name],{encoding:'utf8',windowsHide:true});
    return r.status===0?r.stdout.trim().split(/\r?\n/).find(executable):undefined;
  };
  const bin=path.join(env.LOCALAPPDATA,'OpenAI','Codex','bin');
  let cliCandidates=[];
  if(fs.existsSync(bin))cliCandidates=fs.readdirSync(bin,{withFileTypes:true}).filter(e=>e.isDirectory())
    .map(e=>path.join(bin,e.name,'codex.exe')).filter(executable).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  const cli=[env.CODEX_CLI_PATH,...cliCandidates].find(executable);
  const powershell=[path.join(profile,'.cache','codex-runtimes','codex-primary-runtime','dependencies','native','powershell','pwsh.exe'),
    env.ProgramFiles?path.join(env.ProgramFiles,'PowerShell','7','pwsh.exe'):null,which('pwsh.exe')].find(executable);
  if(!cli||!powershell)throw Error('Codex CLI 또는 PowerShell 7을 찾지 못했습니다. Codex의 로컬 실행 환경 준비를 마친 뒤 다시 실행해 주세요.');
  return {cli,powershell};
}

export function openCli(cli, home, {onRequest,onNotification}={}) {
  const child = spawn(cli,['app-server','--stdio'],{
    cwd:home,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,CODEX_HOME:home}
  });
  const pending=new Map();let id=0,closed=false;
  child.stderr.on('data',()=>{});
  child.stdin.on('error',()=>{});
  const failAll = () => { for(const p of pending.values())p.reject(Error('Codex 연결이 종료됐습니다.'));pending.clear(); };
  child.on('error',failAll);child.on('exit',failAll);
  createInterface({input:child.stdout}).on('line',line=>{
    let item;try{item=JSON.parse(line);}catch{return;}
    if(item.method){
      if(item.id!==undefined)onRequest?.(item,result=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:item.id,result})+'\n'));
      else onNotification?.(item);
      return;
    }
    const waiter=pending.get(item.id);if(!waiter)return;pending.delete(item.id);
    item.error?waiter.reject(Error(`${item.error.message}`)):waiter.resolve(item.result);
  });
  const request = (method,params) => new Promise((resolve,reject)=>{
    if(closed)return reject(Error('Codex 연결이 닫혔습니다.'));
    const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error(`Codex 응답 시간 초과: ${method}`));},20000);
    pending.set(key,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');
  });
  return {request,async initialize(){
    await request('initialize',{clientInfo:{name:'first_prompt_installer',version:'5.2.0'},capabilities:{experimentalApi:true}});
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
  },close(){closed=true;failAll();child.kill();}};
}

function ownsHook(hook,target) {
  return hook?.type==='mcp_tool' && hook.server==='first_prompt_confirm' && hook.tool==='confirm_first_prompt'
    || hook?.type==='command' && typeof hook.command==='string'
      && normalized(hook.command).includes(normalized(path.join(target,'Confirm-FirstPrompt.ps1')));
}
export function mergeHooks(original,target,powershell) {
  if(!original||typeof original!=='object'||Array.isArray(original)
      || original.hooks!=null&&(typeof original.hooks!=='object'||Array.isArray(original.hooks))) {
    throw Error('기존 hooks.json 형식을 확인해 주세요. 파일은 변경하지 않았습니다.');
  }
  const merged=structuredClone(original);merged.hooks??={};
  for(const event of ['SessionStart','UserPromptSubmit']){
    const groups=merged.hooks[event]??[];
    if(!Array.isArray(groups)||groups.some(g=>!Array.isArray(g.hooks)))throw Error(`기존 ${event} 훅 형식이 잘못됐습니다.`);
    merged.hooks[event]=groups.map(g=>({...g,hooks:g.hooks.filter(h=>!ownsHook(h,target))})).filter(g=>g.hooks.length);
  }
  merged.hooks.SessionStart.push({matcher:'^startup$',hooks:[{
    type:'command',command:`& ${psQuote(powershell)} -NoLogo -NoProfile -NonInteractive -File ${psQuote(path.join(target,'Confirm-FirstPrompt.ps1'))}`,timeout:10
  }]});
  merged.hooks.UserPromptSubmit.push({hooks:[{
    type:'mcp_tool',server:'first_prompt_confirm',tool:'confirm_first_prompt',timeout:600,
    statusMessage:'모델·추론 강도 확인을 기다리는 중',input:{model:'${model}',session_id:'${session_id}',hook_event_name:'${hook_event_name}',prompt:'${prompt}'}
  }]});
  return merged;
}

export function checkPayload(root) {
  const manifest=readJson(path.join(root,'manifest.json'));
  if(manifest.name!=='codex-first-prompt-confirm'||manifest.version!=='5.2.0'||!Array.isArray(manifest.files))throw Error('설치 패키지 정보가 올바르지 않습니다.');
  const seen=new Set();
  for(const entry of manifest.files){
    if(!/^[a-zA-Z0-9._-]+$/.test(entry.name)||seen.has(entry.name)||entry.name.includes('..'))throw Error('설치 파일 이름이 올바르지 않습니다.');
    seen.add(entry.name);
    const bytes=fs.readFileSync(path.join(root,'payload',entry.name));
    if(digest(bytes)!==entry.sha256)throw Error(`설치 파일이 변경됐습니다: ${entry.name}`);
  }
  for(const name of ['confirm-first-prompt.mjs','Confirm-FirstPrompt.ps1','app-tools-client.mjs','background-submit.mjs','background-submit-worker.mjs','model-catalog.mjs','ui-copy.json']){
    if(!seen.has(name))throw Error(`설치 파일이 없습니다: ${name}`);
  }
  return manifest;
}

export async function install({root=packageRoot,home,cli,powershell,approve=async()=>false,log=console.log,afterConfig}) {
  home=path.resolve(home);const target=path.join(home,'hooks','first-prompt-confirm');
  const manifest=checkPayload(root);
  if(!fs.existsSync(cli)||!fs.existsSync(powershell))throw Error('Codex 또는 PowerShell 실행 파일을 찾지 못했습니다.');
  const hooksPath=path.join(home,'hooks.json'),configPath=path.join(home,'config.toml');
  const originalHooks=fs.existsSync(hooksPath)?readJson(hooksPath):{hooks:{}};
  const merged=mergeHooks(originalHooks,target,powershell);
  const originalConfigHash=bytesHash(configPath),originalHooksHash=bytesHash(hooksPath);
  if(!await approve({home,target,manifest}))return {cancelled:true};
  fs.mkdirSync(home,{recursive:true});
  const lockPath=path.join(home,'.first-prompt-install.lock');
  const lock=fs.openSync(lockPath,'wx',0o600);
  const rpc=openCli(cli,home),journal=[];let backupDir,serverConfig;
  function remember(file,label){
    const before=fs.existsSync(file)?fs.readFileSync(file):null;
    if(before!==null)fs.writeFileSync(path.join(backupDir,label),before,{mode:0o600});
    const record={file,before,installedHash:null};journal.push(record);return record;
  }
  function replace(file,bytes,label){
    const record=remember(file,label);fs.mkdirSync(path.dirname(file),{recursive:true});
    const temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,bytes,{mode:0o600});fs.renameSync(temp,file);
    record.installedHash=bytesHash(file);return record;
  }
  try{
    await rpc.initialize();
    const initial=await rpc.request('config/read',{includeLayers:false});
    const config=initial.config;
    if(config.allow_managed_hooks_only||config.features?.hooks===false)throw Error('이 PC의 설정/정책에서 사용자 훅을 허용하지 않습니다.');
    const old=config.mcp_servers?.first_prompt_confirm;
    if(old?.args&&!old.args.some(arg=>typeof arg==='string'&&arg.includes('confirm-first-prompt.mjs')))throw Error('동일한 MCP 이름이 이미 사용 중입니다. 기존 설정을 보존하기 위해 중단했습니다.');
    serverConfig={...withoutNulls(old),command:process.execPath,args:[path.join(target,'confirm-first-prompt.mjs')],enabled:true,
      env_vars:[...new Set([...(old?.env_vars??[]),'CODEX_APP_TOOLS_PIPE_PATH'])],
      env:{...old?.env,CODEX_FIRST_PROMPT_CLI_PATH:cli,CODEX_FIRST_PROMPT_PWSH_PATH:powershell}};
    if(bytesHash(configPath)!==originalConfigHash||bytesHash(hooksPath)!==originalHooksHash)throw Error('설치 중 설정 파일이 바뀌었습니다. 잠시 뒤 다시 실행해 주세요.');
    backupDir=path.join(home,'hooks','first-prompt-confirm-backups',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));
    fs.mkdirSync(backupDir,{recursive:true});
    for(const entry of manifest.files){replace(path.join(target,entry.name),fs.readFileSync(path.join(root,'payload',entry.name)),'file-'+entry.name);}
    const configRecord=remember(configPath,'config.toml.before');
    await rpc.request('config/batchWrite',{edits:[{keyPath:'mcp_servers.first_prompt_confirm',value:serverConfig,mergeStrategy:'replace'}],filePath:configPath,reloadUserConfig:false});
    configRecord.installedHash=bytesHash(configPath);
    afterConfig?.();
    replace(hooksPath,Buffer.from(JSON.stringify(merged,null,2)+'\n'),'hooks.json.before');
    // Recipient explicitly reviewed these two handlers above. Trust only the
    // exact definitions reported by Codex, never bypass global hook trust.
    const listing=await rpc.request('hooks/list',{cwds:[home]});
    const own=listing.data.flatMap(row=>row.hooks).filter(h=>normalized(h.sourcePath??'')===normalized(hooksPath)
      && (h.eventName==='userPromptSubmit'&&h.server==='first_prompt_confirm'&&h.tool==='confirm_first_prompt'
      || h.eventName==='sessionStart'&&typeof h.command==='string'&&normalized(h.command).includes(normalized(path.join(target,'Confirm-FirstPrompt.ps1')))));
    if(own.length!==2||own.some(h=>!h.currentHash))throw Error('Codex가 등록한 두 훅을 확인하지 못했습니다.');
    await rpc.request('config/batchWrite',{edits:own.map(h=>({keyPath:`hooks.state.${JSON.stringify(h.key)}`,value:{trusted_hash:h.currentHash},mergeStrategy:'upsert'})),filePath:configPath,reloadUserConfig:false});
    configRecord.installedHash=bytesHash(configPath);
    const verified=await rpc.request('hooks/list',{cwds:[home]});
    const reviewed=verified.data.flatMap(row=>row.hooks).filter(h=>own.some(w=>w.key===h.key));
    if(reviewed.length!==2||reviewed.some(h=>h.trustStatus!=='trusted'||!h.enabled))throw Error('훅 신뢰 상태를 확인하지 못했습니다.');
    const current=await rpc.request('config/read',{includeLayers:false});
    if(current.config.mcp_servers.first_prompt_confirm.command!==process.execPath)throw Error('MCP 등록 확인에 실패했습니다.');
    fs.writeFileSync(path.join(target,'installation.json'),JSON.stringify({version:manifest.version,installedAt:new Date().toISOString(),node:process.execPath,cli,powershell,backupDir},null,2));
    log('설치 완료: '+target);log('기존 파일 백업: '+backupDir);
    log('Codex를 열고 새 채팅에서 확인해 주세요. 실행 중인 앱이나 채팅은 종료하지 않았습니다.');
    if(current.config.approval_policy==='never'||current.config.approval_policy?.granular?.mcp_elicitations===false){
      log('현재 권한 설정은 확인 카드를 생략할 수 있습니다. 앱에서 확인 요청이 허용되는 모드를 선택해 주세요. 기존 권한 설정은 바꾸지 않았습니다.');
    }
    return {installed:true,target,backupDir,manifest,hookKeys:own.map(h=>h.key)};
  }catch(error){
    let incomplete=false;
    for(const record of journal.reverse()){
      try{
        if(record.installedHash===null||bytesHash(record.file)!==record.installedHash){incomplete=true;continue;}
        if(record.before===null)fs.unlinkSync(record.file);else fs.writeFileSync(record.file,record.before);
      }catch{incomplete=true;}
    }
    if(incomplete&&backupDir)log('자동 복원이 일부 보류됐습니다. 다른 변경을 덮어쓰지 않았습니다. 백업: '+backupDir);
    throw error;
  }finally{rpc.close();fs.closeSync(lock);fs.unlinkSync(lockPath);}
}

async function main(){
  const args=process.argv.slice(2),get=flag=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
  const home=get('--home')??process.env.CODEX_HOME??path.join(process.env.USERPROFILE,'.codex');
  if(Number.parseInt(process.versions.node)<20)throw Error('Node.js 20 이상이 필요합니다.');
  const runtimes=get('--cli')&&get('--powershell')?{cli:get('--cli'),powershell:get('--powershell')}:discoverRuntimes();
  const {cli,powershell}=runtimes;
  const rl=questionInterface({input:process.stdin,output:process.stdout});
  try{
    const result=await install({home,cli,powershell,approve:async({target})=>{
      console.log('\nCodex Model Guard 5.2.0 · Windows\n');
      console.log('등록할 훅:');
      console.log('  1. 새 채팅 시작 시 첫 요청 확인 상태 생성');
      console.log('  2. 첫 요청에서 ⭕/❌ 선택, 10초 무응답이면 현재 설정으로 시작');
      console.log('     변경 확정 시 모델·강도 선택 후 텍스트 원문 전송');
      console.log('설치 위치: '+target);
      console.log('기존 설정은 백업하고 다른 MCP·훅·권한 설정은 유지합니다.');
      console.log('관리자 권한이나 로그인 정보 복사는 필요 없습니다.\n');
      const answer=await rl.question('위 두 훅을 설치하고 신뢰하시겠습니까? [Y/N]: ');
      return /^(y|yes|예)$/i.test(answer.trim());
    }});
    if(result.cancelled)console.log('설치를 취소했습니다.');
  }finally{rl.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(error=>{console.error('\n설치 실패: '+error.message);process.exitCode=1;});
}
