import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirmFirstPrompt } from '../payload/confirm-first-prompt.mjs';

const root = mkdtempSync(join(tmpdir(), 'model-guard-confirm-'));
const input = id => ({ session_id: id, hook_event_name: 'UserPromptSubmit', model: 'gpt-6.1-sol' });
const file = id => join(root, createHash('sha256').update(id).digest('hex') + '.txt');
const arm = id => writeFileSync(file(id), 'armed');
const never = () => { throw new Error('Must not show another confirmation'); };

test('waits for explicit acceptance, preserves original turn with empty output, then asks no more', async () => {
  arm('accept');
  let answer;
  let settled = false;
  const pending = confirmFirstPrompt(input('accept'), params => {
    assert.match(params.message, /GPT-6\.1 Sol/);
    assert.deepEqual(params.requestedSchema.required, ['decision']);
    assert.equal(Object.hasOwn(params.requestedSchema.properties.decision, 'default'), false);
    assert.deepEqual(params.requestedSchema.properties.decision.oneOf,
      [{const:'correct',title:'⭕ 맞습니다'},{const:'change',title:'❌ 안 맞습니다'}]);
    assert.equal(params._meta?.['openai/confirmation'], undefined);
    return new Promise(resolve => { answer = resolve; });
  }, root).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(readFileSync(file('accept'), 'utf8'), 'armed');
  answer({ action: 'accept', content: { decision: 'correct' } });
  assert.deepEqual(await pending, {});
  assert.equal(readFileSync(file('accept'), 'utf8'), 'confirmed');
  assert.deepEqual(await confirmFirstPrompt(input('accept'), never, root), {});
});

test('automatic acceptance without explicit input never starts the model request', async () => {
  arm('auto');
  for (const content of [undefined, null, {}, { confirmed: false }, { confirmed: 'true' }, { decision: 'unexpected' }]) {
    const result = await confirmFirstPrompt(input('auto'), async () => ({ action: 'accept', content }), root);
    assert.equal(result.decision, 'block');
    assert.match(result.reason, /설정 확인이 생략/);
    assert.equal(readFileSync(file('auto'), 'utf8'), 'armed');
  }
});
test('cancel, decline, errors and missing acceptance all block and leave confirmation required', async () => {
  arm('cancel');
  for (const action of ['cancel', 'decline', undefined]) {
    const result = await confirmFirstPrompt(input('cancel'), async () => ({ action }), root);
    assert.equal(result.decision, 'block');
    assert.equal(readFileSync(file('cancel'), 'utf8'), 'armed');
  }
  assert.equal((await confirmFirstPrompt(input('cancel'), async () => { throw new Error('Disconnected'); }, root)).decision, 'block');
});
test('existing sessions and legacy acknowledged chats are untouched', async () => {
  assert.deepEqual(await confirmFirstPrompt(input('existing'), never, root), {});
  writeFileSync(file('legacy'), 'warned');
  assert.deepEqual(await confirmFirstPrompt(input('legacy'), never, root), {});
});

test('choice 2 preserves exact multiline prompt without treating it as shell code', async () => {
  arm('recovery');
  const prompt = '원래 질문\r\n`literal` $HOME $(literal) "따옴표"\n끝\n';
  let saved;
  const result = await confirmFirstPrompt({ ...input('recovery'), prompt }, async () => ({ action: 'accept', content: { decision: 'change' } }), root, async text => { saved = text; return true; });
  assert.equal(saved, prompt);
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /모델을 고른 뒤 다시 보내/);
  assert.equal(readFileSync(file('recovery'), 'utf8'), 'armed');
});

test('failed recovery scheduling does not claim success, and transport abort never runs recovery', async () => {
  arm('recovery-failure');
  const result = await confirmFirstPrompt(input('recovery-failure'), async () => ({ action: 'accept', content: { decision: 'change' } }), root, async () => { throw new Error('worker unavailable'); });
  assert.equal(result.decision, 'block');
  assert.doesNotMatch(result.reason, /모델을 고른 뒤 다시 보내/);
  await confirmFirstPrompt(input('recovery-failure'), async () => { throw new Error('Turn stopped'); }, root, never);
});

test('dismiss or skip never acts like an explicit choice 2', async () => {
  arm('escape');
  const prompt = '`Esc 복원 확인`  \r\n둘째 줄\n';
  let restored = false;
  const result = await confirmFirstPrompt({ ...input('escape'), prompt }, async params => {
    assert.match(params.message, /1·2 선택 · Ctrl\+Enter 진행/);
    return { action: 'cancel', content: null };
  }, root, async () => { restored = true; return true; }, undefined, async () => { throw Error('must not open settings'); });
  assert.equal(restored, false);
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /전송을 취소/);
  assert.equal(readFileSync(file('escape'), 'utf8'), 'armed');
});
test('concurrent request cannot skip a pending confirmation', async () => {
  arm('parallel');
  let answer;
  const pending = confirmFirstPrompt(input('parallel'), () => new Promise(resolve => { answer = resolve; }), root);
  assert.equal((await confirmFirstPrompt(input('parallel'), never, root)).decision, 'block');
  answer({ action: 'cancel' });
  assert.equal((await pending).decision, 'block');
});

test('binds the displayed confirmation target and reuses that target after decline', async () => {
  arm('target-binding');
  const binding = { windowId: 12, processId: 34, documentName: 'test', headerId: 'chat-1' };
  const calls = [];
  const result = await confirmFirstPrompt({ ...input('target-binding'), prompt: '`문구 C3`  \n' }, async () => {
    calls.push('elicit'); return { action: 'accept', content: {decision:'change'} };
  }, root, async (text, target) => {
    calls.push('restore'); assert.equal(text, '`문구 C3`  \n'); assert.equal(target, binding); return true;
  }, async () => { calls.push('capture'); return binding; });
  assert.deepEqual(calls, ['elicit', 'capture', 'restore']);
  assert.equal(result.decision, 'block');
});
