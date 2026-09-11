// SPDX-License-Identifier: AGPL-3.0-or-later
import { codexRuntime } from '../../../codex-subscription.js';

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
function textContent(content) {
    if (typeof content === 'string') return content;
    if (content == null) return '';
    if (!Array.isArray(content) || content.some(item => item.type !== 'text')) throw new Error('此 Codex 接入目前支持文本消息，请移除图片或音频附件。');
    return content.map(item => item.text || '').join('\n');
}

export function toCodexContext(body, model) {
    const messages = [];
    const system = [];
    const toolNames = new Map();
    for (const message of body.messages || []) {
        const text = textContent(message.content);
        if (message.role === 'system' || message.role === 'developer') system.push(text);
        else if (message.role === 'user') messages.push({ role: 'user', content: text, timestamp: Date.now() });
        else if (message.role === 'assistant') {
            const content = text ? [{ type: 'text', text }] : [];
            for (const tool of message.tool_calls || []) {
                let args;
                try { args = JSON.parse(tool.function.arguments || '{}'); } catch { throw new Error('历史工具参数格式无效。'); }
                content.push({ type: 'toolCall', id: tool.id, name: tool.function.name, arguments: args });
                toolNames.set(tool.id, tool.function.name);
            }
            messages.push({ role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: message.tool_calls?.length ? 'toolUse' : 'stop', timestamp: Date.now() });
        } else if (message.role === 'tool') messages.push({ role: 'toolResult', toolCallId: message.tool_call_id, toolName: toolNames.get(message.tool_call_id) || message.name || 'tool', content: [{ type: 'text', text }], isError: false, timestamp: Date.now() });
        else throw new Error('Codex 不支持此消息类型。');
    }
    if (body.json_schema?.value) system.push(`Respond with JSON conforming to this schema: ${JSON.stringify(body.json_schema.value)}`);
    return { systemPrompt: system.join('\n\n'), messages, tools: (body.tools || []).map(tool => ({ name: tool.function.name, description: tool.function.description || '', parameters: tool.function.parameters || { type: 'object', properties: {} } })) };
}

export function toCompletion(message) {
    const calls = message.content.filter(item => item.type === 'toolCall').map(item => ({ id: item.id, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.arguments) } }));
    return { id: message.responseId || 'codex-response', object: 'chat.completion', model: message.model,
        choices: [{ index: 0, message: { role: 'assistant', content: message.content.filter(item => item.type === 'text').map(item => item.text).join(''), reasoning_content: message.content.filter(item => item.type === 'thinking').map(item => item.thinking).join(''), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: message.stopReason === 'toolUse' ? 'tool_calls' : message.stopReason === 'length' ? 'length' : 'stop' }],
        usage: { prompt_tokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite, completion_tokens: message.usage.output, total_tokens: message.usage.totalTokens } };
}

export async function dispatchCodexSubscription(ctx, runtime = codexRuntime(ctx.user.directories)) {
    let headed = false;
    try {
        if (!await runtime.credentials.read('openai-codex')) throw new Error('请先在连接管理中登录 Codex 订阅。');
        const model = runtime.models.getModel('openai-codex', ctx.body.model);
        if (!model) throw new Error('此 Codex 模型不在当前支持列表中，请在连接管理中重新选择。');
        const context = toCodexContext(ctx.body, model);
        const effort = { min: 'minimal', max: 'max' }[ctx.body.reasoning_effort] || ctx.body.reasoning_effort;
        const options = { signal: ctx.signal, ...(effort && effort !== 'auto' ? { reasoning: effort } : {}), maxTokens: ctx.body.max_tokens || ctx.body.max_completion_tokens };
        const stream = runtime.models.streamSimple(model, context, options);
        const emit = value => ctx.emit.chunk(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
        let final;
        let toolIndex = 0;
        for await (const event of stream) {
            if (event.type === 'error') throw new Error(ctx.signal.aborted ? '生成已取消。' : 'Codex 请求失败，请检查登录、模型权限或订阅额度后重试。');
            if (!headed) { ctx.emit.head({ status: 200, headers: { 'content-type': ctx.body.stream ? 'text/event-stream' : 'application/json' } }); headed = true; }
            if (ctx.body.stream) {
                let delta;
                if (event.type === 'text_delta') delta = { content: event.delta };
                if (event.type === 'thinking_delta') delta = { reasoning_content: event.delta };
                if (event.type === 'toolcall_end') delta = { tool_calls: [{ index: toolIndex++, id: event.toolCall.id, type: 'function', function: { name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments) } }] };
                if (delta) emit({ choices: [{ index: 0, delta, finish_reason: null }] });
            }
            if (event.type === 'done') final = event.message;
        }
        if (!final) throw new Error('Codex 未返回完整结果。');
        const result = toCompletion(final);
        if (ctx.body.stream) {
            emit({ choices: [{ index: 0, delta: {}, finish_reason: result.choices[0].finish_reason }], usage: result.usage });
            ctx.emit.chunk(new TextEncoder().encode('data: [DONE]\n\n'));
        } else ctx.emit.chunk(new TextEncoder().encode(JSON.stringify(result)));
        ctx.emit.end();
    } catch (error) {
        const message = error.message || 'Codex 请求失败。';
        if (!headed) {
            ctx.emit.head({ status: 400, headers: { 'content-type': 'application/json' } });
            ctx.emit.chunk(new TextEncoder().encode(JSON.stringify({ error: { message } })));
            ctx.emit.end();
        } else ctx.emit.error(new Error(message));
    }
}
