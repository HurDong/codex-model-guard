import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const cachePath = join(root, 'model-catalog.json');
export function validateCatalog(value) {
  if (!Array.isArray(value) || !value.length) throw new Error('model_catalog_unavailable');
  const models = value.filter(m => m && !m.hidden && typeof m.model === 'string' && /^[a-zA-Z0-9._:-]+$/.test(m.model))
    .map(m => ({ model: m.model, displayName: m.displayName || m.model,
      efforts: [...new Set((m.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort)
        .filter(e => typeof e === 'string' && /^[a-zA-Z0-9_-]+$/.test(e))) ] }))
    .filter(m => m.efforts.length);
  if (!models.length) throw new Error('model_catalog_empty');
  return models;
}
function cliPath() {
  if (process.env.CODEX_FIRST_PROMPT_CLI_PATH && existsSync(process.env.CODEX_FIRST_PROMPT_CLI_PATH)) return process.env.CODEX_FIRST_PROMPT_CLI_PATH;
  const bin = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  const candidates = readdirSync(bin).map(name => join(bin, name, 'codex.exe')).filter(existsSync);
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!candidates.length) throw new Error('codex_cli_not_found');
  return candidates[0];
}
export async function readModelCatalog() {
  let cached;
  try {
    cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (Date.now() - cached.at < 6 * 60 * 60 * 1000) return validateCatalog(cached.models);
  } catch {}
  try {
    const models = await new Promise((resolve, reject) => {
      const child = spawn(cliPath(), ['app-server', '--stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      const pending = new Map(); let id = 0;
      const send = value => child.stdin.write(JSON.stringify(value) + '\n');
      const rpc = (method, params) => new Promise((ok, fail) => { const key = ++id; pending.set(key, {ok, fail}); send({id:key, method, params}); });
      const timer = setTimeout(() => { reject(new Error('model_catalog_timeout')); child.kill(); }, 12000);
      child.on('error', reject); child.stdin.on('error', () => {});
      createInterface({input:child.stdout}).on('line', line => {
        let item; try { item = JSON.parse(line); } catch { return; }
        const waiter = pending.get(item.id);
        if (waiter) { pending.delete(item.id); item.error ? waiter.fail(new Error('model_catalog_request_failed')) : waiter.ok(item.result); }
      });
      child.on('exit', () => { for (const p of pending.values()) p.fail(new Error('model_catalog_process_exited')); });
      (async () => {
        try {
          await rpc('initialize', {clientInfo:{name:'first_prompt_model_catalog',version:'1.0'}});
          send({method:'initialized'});
          let all = [], cursor;
          do { const page = await rpc('model/list', {limit:100,includeHidden:false,...(cursor ? {cursor} : {})}); all.push(...page.data); cursor = page.nextCursor; } while (cursor);
          resolve(all);
        } catch (error) { reject(error); }
        finally { clearTimeout(timer); child.kill(); }
      })();
    });
    const result = validateCatalog(models);
    if (!result.length) throw new Error('model_catalog_empty');
    writeFileSync(cachePath, JSON.stringify({at:Date.now(),models}), 'utf8');
    return result;
  } catch (error) {
    if (cached && Date.now() - cached.at < 7 * 86400000) return validateCatalog(cached.models);
    throw error;
  }
}

const effortNames = {none:'없음',minimal:'최소',low:'Low · 낮음',medium:'Medium · 보통',high:'High · 높음',xhigh:'XHigh · 매우 높음',max:'Max · 최대',ultra:'Ultra · 자동 작업 위임 포함'};
export async function chooseSettings(elicit, currentModel, catalogReader = readModelCatalog) {
  const models = await catalogReader();
  const first = await elicit({mode:'form', message:'시작 설정 · 모델\n\n이 경로는 텍스트 원문만 보냅니다. 첨부파일이 있으면 취소하고 원래 메시지에서 다시 보내 주세요.', requestedSchema:{type:'object',
    properties:{model:{type:'string',title:'모델',oneOf:models.map(m => ({const:m.model,title:m.displayName + (m.model === currentModel ? ' · 현재' : '')}))}},required:['model']}});
  if (first?.action !== 'accept') return null;
  const model = models.find(m => m.model === first.content?.model);
  if (!model) throw new Error('invalid_model_selection');
  const second = await elicit({mode:'form',message:model.displayName + ' · 추론 강도',requestedSchema:{type:'object',
    properties:{effort:{type:'string',title:'추론 강도',description:'선택 후 Ctrl+Enter를 누르면 이 설정으로 텍스트 원문을 보냅니다.',
      oneOf:model.efforts.map(e => ({const:e,title:effortNames[e] ?? e}))}},required:['effort']}});
  if (second?.action !== 'accept') return null;
  if (!model.efforts.includes(second.content?.effort)) throw new Error('invalid_effort_selection');
  return {model:model.model,effort:second.content.effort};
}
