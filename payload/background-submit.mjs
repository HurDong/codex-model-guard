import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { AppToolsClient } from './app-tools-client.mjs';

const root = dirname(fileURLToPath(import.meta.url));
export const hash = text => createHash('sha256').update(text).digest('hex');
const normalized = text => text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
const promptHash = text => hash(normalized(text));

export function inspectOriginal(snapshot, input, turnId, allowEmptySource = false) {
  if (snapshot?.thread?.id !== input.session_id || snapshot.thread.kind !== 'codex'
      || snapshot.thread.hostId !== 'local') throw new Error('target_thread_mismatch');
  const turn = snapshot.turns?.[0];
  if (!turn?.id || (turnId && turn.id !== turnId)) throw new Error('source_turn_changed');
  if (/# Files mentioned by the user:|<image\b|\[Image #\d+\]|\[(?:attachment|첨부파일)\]/i.test(input.prompt)) {
    throw new Error('attachments_require_original_send');
  }
  const messages = (turn.items ?? []).filter(item => item.type === 'userMessage');
  // A UserPromptSubmit block deliberately never persists the pending input.
  // The trusted hook supplies the text; bind it to the active empty turn id.
  // This is text-only transport, disclosed in the model/effort selection card.
  if (!messages.length && allowEmptySource) {
    if ((turn.items ?? []).some(item => item.type !== 'hookPrompt')) throw new Error('source_already_started');
    return turn;
  }
  if (messages.length !== 1) throw new Error('source_prompt_unavailable');
  const content = messages[0].content;
  if (!Array.isArray(content) || !content.length || content.some(item => item.type !== 'text')) {
    throw new Error('attachments_require_original_send');
  }
  const text = content.map(item => item.text).join('\n');
  if (typeof text !== 'string' || promptHash(text) !== promptHash(input.prompt)) {
    throw new Error('source_prompt_changed');
  }
  // The public app tool accepts text only. Refuse file/image references rather
  // than silently dropping the original request's attachment context.
  if (/# Files mentioned by the user:|<image\b|\[Image #\d+\]|\[(?:attachment|첨부파일)\]/i.test(text)) {
    throw new Error('attachments_require_original_send');
  }
  return turn;
}

export async function prepareBackground(input, client = new AppToolsClient()) {
  try {
    const tools = await client.listTools();
    const send = tools.find(tool => tool.namespace === 'codex_app' && tool.name === 'send_message_to_thread');
    if (!send?.inputSchema?.properties?.model || !send.inputSchema.properties.thinking
        || !tools.some(tool => tool.namespace === 'codex_app' && tool.name === 'read_thread')) {
      throw new Error('app_settings_send_unavailable');
    }
    const snapshot = await client.readThread(input.session_id);
    const emptyActive = snapshot.thread?.status?.type === 'active' && snapshot.turns?.[0]?.status === 'inProgress';
    const turn = inspectOriginal(snapshot, input, undefined, emptyActive);
    return {mode:'app-pipe', threadId:input.session_id, turnId:turn.id, promptHash:promptHash(input.prompt),
      promptSource:(turn.items ?? []).some(item => item.type === 'userMessage') ? 'history' : 'hook'};
  } catch (error) { return {mode:'unavailable', code:error.message}; }
}

function jobFolder(baseDir, threadId) { return join(baseDir, 'background', hash(threadId)); }
function status(dir, value) {
  mkdirSync(dir, {recursive:true});
  writeFileSync(join(dir, 'status.json'), JSON.stringify({at:new Date().toISOString(), ...value}), {mode:0o600});
}

export function saveUnsent(input, code = 'selection_cancelled', baseDir = root) {
  const dir = jobFolder(baseDir, input.session_id);
  mkdirSync(dir, {recursive:true});
  writeFileSync(join(dir, 'unsent.json'), JSON.stringify({threadId:input.session_id, prompt:input.prompt}), {mode:0o600});
  status(dir, {status:code, submitted:false});
}

export async function queueBackground(input, binding, options, baseDir = root) {
  if (options?.restoreOnly) { saveUnsent(input, 'selection_cancelled', baseDir); return true; }
  if (binding?.mode !== 'app-pipe') {
    saveUnsent(input, binding?.code ?? 'app_pipe_unavailable', baseDir); return false;
  }
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(baseDir, 'background-submit-worker.mjs')], {
      detached:true, windowsHide:true, stdio:['pipe', 'ignore', 'ignore', 'ipc']
    });
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (child.connected) child.disconnect();
      child.unref(); resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(false); }, 5000);
    child.once('message', value => finish(value?.ready === true));
    child.once('error', () => finish(false));
    child.once('exit', () => finish(false));
    child.stdin.on('error', () => finish(false));
    child.stdin.end(JSON.stringify({input, binding, ...options}), 'utf8');
  });
}

export async function submitBackground(job, {client = new AppToolsClient(), baseDir = root,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
    timeoutMs = 25000, ready = () => {}} = {}) {
  const {input, binding, selection, grant} = job;
  if (!input || typeof input.prompt !== 'string' || !input.prompt.trim()
      || !/^[a-f0-9-]{36}$/i.test(input.session_id ?? '')
      || binding?.mode !== 'app-pipe' || binding.threadId !== input.session_id
      || binding.promptHash !== promptHash(input.prompt)
      || grant?.promptHash !== binding.promptHash
      || basename(grant?.path ?? '') !== `${hash(input.session_id)}.txt`
      || selection?.model !== grant?.model || selection?.effort !== grant?.effort) {
    throw new Error('invalid_background_job');
  }
  const dir = jobFolder(baseDir, input.session_id), id = randomUUID();
  mkdirSync(dir, {recursive:true});
  const lockPath = join(dir, 'submit.lock');
  // A retained lock after a crash/unknown outcome intentionally needs review.
  const lock = openSync(lockPath, 'wx', 0o600);
  let attempted = false, succeeded = false;
  const ownGrant = () => {
    try { return JSON.parse(readFileSync(grant.path, 'utf8')).jobId === id; }
    catch { return false; }
  };
  try {
    const tools = await client.listTools();
    const tool = tools.find(tool => tool.namespace === 'codex_app' && tool.name === 'send_message_to_thread');
    if (!tool?.inputSchema?.properties?.model || !tool?.inputSchema?.properties?.thinking
        || !tools.some(tool => tool.name === 'read_thread' && tool.namespace === 'codex_app')) {
      throw new Error('app_settings_send_unavailable');
    }
    const efforts = tool.inputSchema.properties.thinking.enum;
    if (Array.isArray(efforts) && !efforts.includes(selection.effort)) throw new Error('invalid_effort_selection');
    if (readFileSync(grant.path, 'utf8').trim() !== 'armed') throw new Error('source_state_changed');
    saveUnsent(input, 'waiting_for_original_turn', baseDir);
    ready();
    const deadline = now() + timeoutMs;
    while (true) {
      const snapshot = await client.readThread(input.session_id);
      const turn = inspectOriginal(snapshot, input, binding.turnId, binding.promptSource === 'hook');
      if (turn.status === 'interrupted' || turn.error) throw new Error('source_turn_cancelled');
      if (snapshot.thread.status?.type === 'idle' && turn.status === 'completed') {
        if ((turn.items ?? []).some(item => item.type === 'agentMessage')) throw new Error('source_already_answered');
        break;
      }
      if (snapshot.thread.status?.type !== 'active' || turn.status !== 'inProgress') throw new Error('source_not_ready');
      if (now() >= deadline) throw new Error('source_idle_timeout');
      await sleep(200);
    }
    // Re-read immediately before sending; no foreground or draft is touched.
    const latest = await client.readThread(input.session_id);
    const turn = inspectOriginal(latest, input, binding.turnId, binding.promptSource === 'hook');
    if (latest.thread.status?.type !== 'idle' || turn.status !== 'completed') throw new Error('source_turn_changed');
    if (readFileSync(grant.path, 'utf8').trim() !== 'armed') throw new Error('source_state_changed');
    writeFileSync(grant.path, JSON.stringify({kind:'selected-submit', ...grant, jobId:id, expiresAt:now()+30000}), 'utf8');
    status(dir, {status:'sending', submitted:false, model:selection.model, effort:selection.effort});
    attempted = true;
    const result = await client.send(input.session_id, input.prompt, selection, binding.turnId);
    if (result?.threadId !== input.session_id) throw new Error('submission_result_invalid');
    succeeded = true;
    if (ownGrant()) writeFileSync(grant.path, 'confirmed', 'utf8');
    status(dir, {status:'submitted', submitted:true, model:selection.model, effort:selection.effort});
    try { unlinkSync(join(dir, 'unsent.json')); } catch {}
    return {submitted:true};
  } catch (error) {
    if (ownGrant()) writeFileSync(grant.path, 'armed', 'utf8');
    const uncertain = attempted;
    saveUnsent(input, uncertain ? 'send_outcome_unknown' : /^[a-z_]+$/.test(error.message) ? error.message : 'background_failed', baseDir);
    status(dir, {status:uncertain ? 'send_outcome_unknown' : /^[a-z_]+$/.test(error.message) ? error.message : 'background_failed',
      submitted:false, automaticRetry:false, model:selection.model, effort:selection.effort});
    return {submitted:false, uncertain};
  } finally {
    closeSync(lock);
    if (!attempted || succeeded) { try { unlinkSync(lockPath); } catch {} }
  }
}
