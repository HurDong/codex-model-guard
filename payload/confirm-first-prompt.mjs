import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { chooseSettings } from './model-catalog.mjs';
import { prepareBackground, queueBackground, saveUnsent } from './background-submit.mjs';

const baseDir = dirname(fileURLToPath(import.meta.url));
const pendingSessions = new Set();
const block = reason => ({ decision: 'block', reason });
const promptHash = text => createHash('sha256').update(text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')).digest('hex');

const defaultCopy = {
  name: '시작 설정',
  effortHint: '추론 강도는 입력창 아래에서 확인',
  shortcuts: '1·2 선택 · Ctrl+Enter 진행',
  choiceLabel: '현재 설정이 맞나요?',
  correctLabel: '맞습니다',
  changeLabel: '안 맞습니다',
  declined: '모델을 고른 뒤 다시 보내 주세요.',
  restoreUnavailable: '메시지의 ‘수정’을 눌러 다시 열어 주세요.',
  cancelled: '전송을 취소했어요.',
  invalidRequest: '질문을 확인하지 못했어요. 다시 보내 주세요.',
  invalidState: '설정을 불러오지 못했어요. 다시 시도해 주세요.',
  pending: '설정 확인이 이미 열려 있어요.',
  automaticAcceptance: '설정 확인이 생략됐어요. 권한을 ‘맞춤형’으로 바꿔 주세요.',
  failed: '설정 확인을 마치지 못했어요. 다시 시도해 주세요.'
};

function loadCopy() {
  try {
    const custom = JSON.parse(readFileSync(join(baseDir, 'ui-copy.json'), 'utf8'));
    return Object.fromEntries(Object.entries(defaultCopy).map(([key, fallback]) =>
      [key, typeof custom?.[key] === 'string' && custom[key].trim() && custom[key].length <= 1000 ? custom[key] : fallback]));
  } catch { return defaultCopy; }
}

function modelLabel(value) {
  return value.replace(/^gpt-(\d+(?:\.\d+)?)-([a-z][a-z0-9-]*)$/i, (_, version, family) =>
    `GPT-${version} ${family.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join(' ')}`);
}

export function preparePendingRecovery({readOnly = false} = {}) {
  const script = join(baseDir, 'Capture-RecoveryTarget.ps1');
  if (!existsSync(script)) return Promise.resolve(undefined);
  const powershell = process.env.CODEX_FIRST_PROMPT_PWSH_PATH ?? join(process.env.USERPROFILE ?? '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe');
  return new Promise(resolve => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', script, ...(readOnly ? ['-ReadOnly'] : [])], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', chunk => { if (output.length < 20000) output += chunk; });
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 4000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => {
      clearTimeout(timer);
      try { resolve(code === 0 ? JSON.parse(output) : null); } catch { resolve(null); }
    });
  });
}

// Historical export/script names are kept so existing clients keep working.
// This operation queues direct editor restoration and never uses a clipboard.
export function copyPendingPrompt(prompt, binding, options = {}) {
  if (typeof prompt !== 'string' || !prompt.length) return Promise.resolve(false);
  const powershell = process.env.CODEX_FIRST_PROMPT_PWSH_PATH ?? join(process.env.USERPROFILE ?? '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe');
  return new Promise(resolve => {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', join(baseDir, 'Copy-PendingPrompt.ps1')];
    if (binding !== undefined || Object.keys(options).length) args.push('-EnvelopeInput');
    const child = spawn(powershell, args, {
      windowsHide: true, stdio: ['pipe', 'ignore', 'ignore']
    });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 4000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0); });
    child.stdin.on('error', () => {});
    child.stdin.end(binding === undefined && !Object.keys(options).length ? prompt : JSON.stringify({ recoveryRequestVersion: 1, prompt, binding, declinedAtMs: Date.now(), ...options }), 'utf8');
  });
}

export async function confirmFirstPrompt(input, elicit, stateRoot = join(baseDir, 'state'), copy = copyPendingPrompt, prepare = async () => undefined, picker) {
  const ui = loadCopy();
  if (input.hook_event_name !== 'UserPromptSubmit' || typeof input.session_id !== 'string' || !input.session_id) {
    return block(ui.invalidRequest);
  }
  const key = createHash('sha256').update(input.session_id).digest('hex');
  const path = join(stateRoot, `${key}.txt`);
  try {
    let state;
    try { state = readFileSync(path, 'utf8').trim(); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    // No startup marker means an existing/resumed/forked chat. Legacy warned
    // markers remain valid so upgrading does not interrupt existing chats.
    if (state === 'warned' || state === 'confirmed') return {};
    if (state.startsWith('{')) {
      let grant; try { grant = JSON.parse(state); } catch {}
      if (grant?.kind === 'selected-submit' && grant.expiresAt > Date.now()
          && grant.model === input.model && typeof input.prompt === 'string'
          && grant.promptHash === promptHash(input.prompt)) {
        writeFileSync(path, 'confirmed', 'utf8');
        return {};
      }
      writeFileSync(path, 'armed', 'utf8'); state = 'armed';
    }
    if (state !== 'armed') return block(ui.invalidState);
    if (pendingSessions.has(key)) return block(ui.pending);
    pendingSessions.add(key);
    try {
      const model = typeof input.model === 'string' ? input.model.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 100) : '입력창에서 확인';
      const answer = Promise.resolve(elicit({
        mode: 'form',
        message: [ui.name, '', modelLabel(model), ui.effortHint, '', ui.shortcuts].join('\n'),
        // Native single-choice form supplies numbered choices and Ctrl+Enter.
        // Do not use openai/confirmation: its Accept/Decline footer is a
        // different interaction and does not return the selected choice.
        requestedSchema: {
          type: 'object',
          properties: {
            decision: { type: 'string', title: ui.choiceLabel, oneOf: [
              { const: 'correct', title: ui.correctLabel },
              { const: 'change', title: ui.changeLabel }
            ] }
          },
          required: ['decision']
        }
      })).then(response => ({ response }), error => ({ error }));
      // The first-submit view can still be switching routes before the card
      // appears. Capture the displayed card's target, not the preceding page.
      let recoveryBinding;
      try { recoveryBinding = await prepare(); } catch { recoveryBinding = null; }
      const settled = await answer;
      if (settled.error) throw settled.error;
      const response = settled.response;
      if (response?.action !== 'accept') return block(ui.cancelled);
      if (!['correct', 'change'].includes(response.content?.decision)) {
        return block(ui.automaticAcceptance);
      }
      if (response.content.decision === 'change') {
        if (picker) {
          let selection;
          try { selection = await picker(elicit, input.model); }
          catch (error) {
            if (/Confirmation cancelled|Client disconnected|Elicitation failed/.test(error?.message ?? '')) return block(ui.cancelled);
            await copy(input.prompt, recoveryBinding, {restoreOnly:true});
            return block('설정을 불러오지 못했어요. 원문에서 다시 시도해 주세요.');
          }
          if (!selection) {
            await copy(input.prompt, recoveryBinding, {restoreOnly:true});
            return block(ui.cancelled);
          }
          const grant = {path, model:selection.model, effort:selection.effort,
            promptHash:promptHash(input.prompt)};
          let scheduled = false;
          try { scheduled = await copy(input.prompt, recoveryBinding, {selection,grant}); } catch {}
          return block(scheduled ? '선택한 설정으로 전송합니다.' : ui.restoreUnavailable);
        }
        let scheduled = false;
        try { scheduled = await copy(input.prompt, recoveryBinding); } catch {}
        return block(scheduled ? ui.declined : ui.restoreUnavailable);
      }
      writeFileSync(path, 'confirmed', 'utf8');
      // Empty hook output allows the original turn to continue intact.
      return {};
    } finally { pendingSessions.delete(key); }
  } catch {
    return block(ui.failed);
  }
}

function startServer() {
  const stateArg = process.argv.indexOf('--state-root');
  const stateRoot = stateArg >= 0 ? resolve(process.argv[stateArg + 1]) : join(baseDir, 'state');
  const pending = new Map();
  const cancelledCalls = new Set();
  let nextId = 1;
  let supportsForm = false;
  const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const elicit = (params, parentId) => {
    if (cancelledCalls.has(parentId)) return Promise.reject(new Error('Confirmation cancelled'));
    if (!supportsForm) return Promise.reject(new Error('Client does not support form elicitation'));
    const id = `confirm-${nextId++}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, parentId });
      send({ id, method: 'elicitation/create', params });
    });
  };
  const tool = {
    name: 'confirm_first_prompt',
    title: loadCopy().name,
    description: 'Internal lifecycle callback for UserPromptSubmit. Runs automatically before the first model request; do not call during ordinary tasks.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, hook_event_name: { type: 'string' }, model: { type: 'string' }, prompt: { type: 'string' } },
      required: ['session_id', 'hook_event_name'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  };
  const lines = createInterface({ input: process.stdin });
  lines.on('line', async line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message.method) {
      const waiting = pending.get(message.id);
      if (waiting) {
        pending.delete(message.id);
        if (message.error) waiting.reject(new Error('Elicitation failed'));
        else waiting.resolve(message.result);
      }
      return;
    }
    if (message.method === 'notifications/cancelled') {
      cancelledCalls.add(message.params?.requestId);
      for (const [id, item] of pending) {
        if (item.parentId === message.params?.requestId || id === message.params?.requestId) {
          pending.delete(id);
          item.reject(new Error('Confirmation cancelled'));
        }
      }
      return;
    }
    if (message.id === undefined) return;
    try {
      let result;
      switch (message.method) {
        case 'initialize': {
          const capability = message.params?.capabilities?.elicitation;
          supportsForm = capability !== undefined && (capability.form !== undefined || capability.url === undefined);
          result = { protocolVersion: message.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: loadCopy().name, title: loadCopy().name, version: '5.1.0' } };
          break;
        }
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: [tool] }; break;
        case 'tools/call': {
          if (message.params?.name !== tool.name) throw new Error('Unknown tool');
          let output;
          const input = message.params.arguments ?? {};
          try { output = await confirmFirstPrompt(input, params => elicit(params, message.id), stateRoot,
            async (_prompt, binding, options) => {
              if (options?.restoreOnly) {
                saveUnsent(input);
                // Cancelling the picker keeps the existing guarded draft
                // restoration. This never focuses a window or uses clipboard.
                const target = await preparePendingRecovery({readOnly:true});
                return target ? copyPendingPrompt(input.prompt, target, options) : false;
              }
              return queueBackground(input, binding, options);
            },
            () => prepareBackground(input), chooseSettings); }
          finally { cancelledCalls.delete(message.id); }
          result = { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
          break;
        }
        case 'resources/list': result = { resources: [] }; break;
        case 'prompts/list': result = { prompts: [] }; break;
        default: send({ id: message.id, error: { code: -32601, message: 'Method not found' } }); return;
      }
      send({ id: message.id, result });
    } catch {
      send({ id: message.id, error: { code: -32603, message: 'First-prompt confirmation failed' } });
    }
  });
  lines.on('close', () => {
    for (const item of pending.values()) item.reject(new Error('Client disconnected'));
    pending.clear();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
