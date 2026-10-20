import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {readSettings,toggleSetting,settingsLocation} from './guard-settings.mjs';

async function main() {
  const args=process.argv.slice(2),index=args.indexOf('--home');
  const home=index>=0?args[index+1]:process.env.CODEX_HOME??(process.env.USERPROFILE&&path.join(process.env.USERPROFILE,'.codex'));
  if(!home)throw Error('Codex 홈 경로를 확인하지 못했습니다.');
  const file=settingsLocation(home);
  if(!fs.existsSync(path.join(path.dirname(file),'confirm-first-prompt.mjs')))throw Error('먼저 설치.cmd를 실행해 주세요.');
  const show=()=>{
    const current=readSettings(file);
    if(process.stdout.isTTY)console.clear();
    console.log('\nCodex Model Guard\n');
    console.log(`  1  첫 설정 확인       [${current.enabled?'ON':'OFF'}]`);
    console.log(`  2  10초 자동 진행    [${current.autoContinue?'ON':'OFF'}]`);
    console.log('\n  0  닫기\n');
    console.log('번호를 입력하고 Enter를 누르면 켜거나 끕니다. 바로 저장됩니다.');
    if(!current.enabled)console.log('첫 설정 확인이 OFF이면 자동 진행 설정은 사용하지 않습니다.');
    console.log('다음 확인 요청부터 적용됩니다. 이미 열린 카드는 그대로 유지됩니다.\n');
    process.stdout.write('선택: ');
  };
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  try {
    show();
    for await(const answer of lines){
      const choice=answer.trim();
      if(choice==='0')return;
      if(choice==='1'||choice==='2'){
        try { toggleSetting(file,choice==='1'?'enabled':'autoContinue'); }
        catch(error) { console.log('\n'+error.message);process.stdout.write('선택: ');continue; }
      }
      show();
    }
  } finally { lines.close(); }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(error=>{console.error('\n'+error.message);process.exitCode=1;});
}
