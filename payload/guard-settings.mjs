import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const defaults = Object.freeze({enabled:true,autoContinue:true});

function document(file) {
  let value;
  try { value=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')); }
  catch(error) { if(error.code==='ENOENT')return {}; throw Error('설정 파일을 읽지 못했습니다: '+file); }
  if(!value||typeof value!=='object'||Array.isArray(value)
      ||Object.keys(defaults).some(key=>key in value&&typeof value[key]!=='boolean')) {
    throw Error('설정 파일 형식을 확인해 주세요: '+file);
  }
  return value;
}

export function readSettings(file) {
  const value=document(file);
  return Object.fromEntries(Object.entries(defaults).map(([key,fallback])=>[key,value[key]??fallback]));
}

export function toggleSetting(file, key) {
  if(!Object.hasOwn(defaults,key))throw Error('알 수 없는 설정입니다.');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const lockPath=file+'.lock';
  let lock;
  try { lock=fs.openSync(lockPath,'wx',0o600); }
  catch(error) { if(error.code==='EEXIST')throw Error('다른 설정 창에서 저장 중입니다. 잠시 후 다시 시도해 주세요.'); throw error; }
  const temporary=file+'.'+randomUUID()+'.tmp';
  try {
    const before=document(file),current=readSettings(file);
    const next={...before,...current,[key]:!current[key]};
    fs.writeFileSync(temporary,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});
    fs.renameSync(temporary,file);
    return readSettings(file);
  } finally {
    if(fs.existsSync(temporary))fs.unlinkSync(temporary);
    fs.closeSync(lock);fs.unlinkSync(lockPath);
  }
}

export function settingsLocation(home) {
  return path.join(path.resolve(home),'hooks','first-prompt-confirm','settings.json');
}
