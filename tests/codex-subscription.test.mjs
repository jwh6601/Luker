import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setConfigFilePath } from '../src/util.js';
setConfigFilePath(new URL('../config.yaml', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const { createCredentialStore, parseOAuthCredential, CODEX_KEY } = await import('../src/codex-subscription.js');
const { SecretManager } = await import('../src/endpoints/secrets.js');
const { toCodexContext, toCompletion, dispatchCodexSubscription } = await import('../src/luker-dispatch/providers/chat-completions/codex-subscription.js');
const model = { id: 'test-model', provider: 'openai-codex', api: 'openai-codex-responses' };
const credential = { type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: 100 };
const usage = { input: 2, cacheRead: 3, cacheWrite: 0, output: 4, totalTokens: 9 };
const done = { ...model, model: model.id, role: 'assistant', content: [{ type: 'text', text: 'Hello' }], stopReason: 'stop', usage };

test('OAuth parsing does not include invalid secret data in errors', () => {
    assert.equal(parseOAuthCredential(undefined), undefined);
    assert.throws(() => parseOAuthCredential('sensitive-invalid-token'), error => !error.message.includes('sensitive'));
    assert.throws(() => parseOAuthCredential(JSON.stringify({ ...credential, refresh: '' })));
});

test('serialized refresh persists one credential, preserves identity, isolates users and survives reopening', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-codex-test-'));
    try {
        const manager = new SecretManager({ root });
        const store = createCredentialStore(manager);
        await store.modify('openai-codex', async () => credential);
        const id = manager.getAllSecrets()[CODEX_KEY][0].id;
        await Promise.all(Array.from({ length: 4 }, () => store.modify('openai-codex', async current => {
            await new Promise(resolve => setTimeout(resolve, 2));
            return { ...current, expires: current.expires + 1 };
        })));
        assert.equal((await createCredentialStore(new SecretManager({ root })).read('openai-codex')).expires, 104);
        assert.equal(manager.getAllSecrets()[CODEX_KEY].length, 1);
        assert.equal(manager.getAllSecrets()[CODEX_KEY][0].id, id);
        assert.equal(manager.getMaskedValue(JSON.stringify(credential), CODEX_KEY), '**********');
        assert.equal(await store.read('another-provider'), undefined);
        await store.delete('openai-codex');
        assert.equal(await store.read('openai-codex'), undefined);
    } finally { fs.rmSync(root, { recursive: true }); }
});

test('tool calls and results retain identities and JSON arguments', () => {
    const mapped = toCodexContext({ messages: [{ role: 'system', content: 'Plan' }, { role: 'user', content: 'Go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{"a":1}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'Found' }], tools: [{ function: { name: 'lookup', parameters: { type: 'object' } } }] }, model);
    assert.equal(mapped.systemPrompt, 'Plan');
    assert.equal(mapped.messages[2].toolName, 'lookup');
    assert.equal(mapped.messages[2].toolCallId, 'call-1');
    assert.deepEqual(mapped.messages[1].content[0].arguments, { a: 1 });
    assert.throws(() => toCodexContext({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }, model), /文本/);
    const result = toCompletion({ ...done, content: [{ type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { a: 1 } }], stopReason: 'toolUse' });
    assert.equal(result.choices[0].finish_reason, 'tool_calls');
    assert.equal(result.choices[0].message.tool_calls[0].function.arguments, '{"a":1}');
    assert.equal(result.usage.prompt_tokens, 5);
});

function fixture(events, connected = true, stream = true) {
    const emitted = [];
    const controller = new AbortController();
    const ctx = { body: { model: model.id, messages: [{ role: 'user', content: 'Hi' }], stream, reasoning_effort: 'high' }, user: { directories: {} }, signal: controller.signal,
        emit: Object.fromEntries(['head', 'chunk', 'end', 'error'].map(kind => [kind, value => emitted.push({ kind, value })])) };
    let options;
    const runtime = { credentials: { read: async () => connected ? credential : undefined }, models: { getModel: () => model,
        streamSimple(_model, _context, opts) { options = opts; return (async function* () { for (const event of events) yield event; })(); } } };
    return { ctx, runtime, emitted, options: () => options };
}
test('stream conversion emits text, tool arguments, usage and completion through existing dispatch protocol', async () => {
    const f = fixture([{ type: 'text_delta', delta: 'Hello' }, { type: 'toolcall_end', toolCall: { id: 'one', name: 'lookup', arguments: { x: 2 } } }, { type: 'done', message: done }]);
    await dispatchCodexSubscription(f.ctx, f.runtime);
    assert.equal(f.emitted[0].kind, 'head');
    assert.equal(f.emitted.at(-1).kind, 'end');
    const text = f.emitted.filter(item => item.kind === 'chunk').map(item => new TextDecoder().decode(item.value)).join('');
    assert.match(text, /Hello/); assert.match(text, /tool_calls/); assert.match(text, /\[DONE\]/);
    assert.equal(f.options().signal, f.ctx.signal); assert.equal(f.options().reasoning, 'high');
});
test('nonstream output is a complete OpenAI-shaped result', async () => {
    const f = fixture([{ type: 'done', message: done }], true, false);
    await dispatchCodexSubscription(f.ctx, f.runtime);
    const result = JSON.parse(new TextDecoder().decode(f.emitted.find(item => item.kind === 'chunk').value));
    assert.equal(result.choices[0].message.content, 'Hello');
});
test('missing credentials and upstream errors return a failed HTTP response without leaking details', async () => {
    for (const f of [fixture([], false), fixture([{ type: 'error', error: { errorMessage: 'sensitive-provider-payload' } }])]) {
        await dispatchCodexSubscription(f.ctx, f.runtime);
        assert.equal(f.emitted[0].kind, 'head');
        assert.equal(f.emitted[0].value.status, 400);
        const text = new TextDecoder().decode(f.emitted.find(item => item.kind === 'chunk').value);
        assert.ok(JSON.parse(text).error.message);
        assert.ok(!text.includes('sensitive'));
    }
});
