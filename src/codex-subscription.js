// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from DeepSeek Harness llm-pi-ai oauth-store/oauth-commands (MIT).
// Copyright (c) 2026 DeepSeek. See docs/DSH代码复用许可.txt.
import express from 'express';
import { createModels } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { SecretManager } from './endpoints/secrets.js';

export const CODEX_URL = 'https://codex.luker.invalid';
export const CODEX_KEY = 'openai_codex_oauth';
const providerId = 'openai-codex';
const runtimes = new Map();
let activeLogin;

export function parseOAuthCredential(value) {
    if (!value) return undefined;
    let credential;
    try { credential = JSON.parse(value); } catch { throw new Error('Codex 登录信息已损坏，请重新登录。'); }
    if (credential?.type !== 'oauth' || typeof credential.access !== 'string' || !credential.access
        || typeof credential.refresh !== 'string' || !credential.refresh || !Number.isFinite(credential.expires)) {
        throw new Error('Codex 登录信息不完整，请重新登录。');
    }
    return credential;
}

// Same serialized read/modify/write seam as DSH. OAuth stays in the existing
// per-user secret store, never in browser settings or connection profiles.
export function createCredentialStore(manager) {
    let pending = Promise.resolve();
    const serial = fn => {
        const result = pending.then(fn);
        pending = result.catch(() => {});
        return result;
    };
    const read = async id => id === providerId ? parseOAuthCredential(manager.readSecret(CODEX_KEY)) : undefined;
    return {
        read,
        async list() { return await read(providerId) ? [{ providerId, type: 'oauth' }] : []; },
        modify(id, fn) {
            return serial(async () => {
                if (id !== providerId) throw new Error('Unsupported credential provider');
                const current = await read(id);
                const next = await fn(current);
                if (next !== undefined) {
                    parseOAuthCredential(JSON.stringify(next));
                    manager.replaceSecretValue(CODEX_KEY, JSON.stringify(next), 'Codex 订阅');
                }
                return next ?? current;
            });
        },
        delete(id) { return serial(() => { if (id === providerId) manager.deleteSecret(CODEX_KEY); }); },
    };
}

export function codexRuntime(directories) {
    const key = directories.root;
    if (!runtimes.has(key)) {
        const credentials = createCredentialStore(new SecretManager(directories));
        const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
        models.setProvider(openaiCodexProvider());
        runtimes.set(key, { credentials, models });
    }
    return runtimes.get(key);
}

const loginSnapshot = login => ({ state: login.state, url: login.url, message: login.message });
export const codexRouter = express.Router();
codexRouter.post('/status', async (req, res) => {
    try {
        const runtime = codexRuntime(req.user.directories);
        const credential = await runtime.credentials.read(providerId);
        res.json({ connected: Boolean(credential), models: runtime.models.getModels(providerId).map(model => ({ id: model.id, name: model.name })),
            login: activeLogin?.owner === req.user.directories.root ? loginSnapshot(activeLogin) : null });
    } catch { res.status(500).json({ error: '无法读取 Codex 登录状态，请重新登录。' }); }
});
codexRouter.post('/login', async (req, res) => {
    if (activeLogin?.state === 'waiting') return res.status(409).json({ error: '已有登录正在进行，请先完成或取消。' });
    const controller = new AbortController();
    const login = { owner: req.user.directories.root, state: 'waiting', controller, url: '', message: '正在准备登录…', submit: null };
    activeLogin = login;
    const timer = setTimeout(() => controller.abort(), 5 * 60_000);
    timer.unref();
    const { models } = codexRuntime(req.user.directories);
    login.task = models.login(providerId, 'oauth', {
        signal: controller.signal,
        notify(event) { if (event.type === 'auth_url') { login.url = event.url; login.message = '请在浏览器中完成登录。'; } },
        async prompt(prompt) {
            if (prompt.type === 'select' && prompt.options.some(option => option.id === 'browser')) return 'browser';
            if (prompt.type !== 'manual_code') throw new Error('Unsupported login prompt');
            const signal = prompt.signal ? AbortSignal.any([prompt.signal, controller.signal]) : controller.signal;
            return new Promise((resolve, reject) => {
                const abort = () => { login.submit = null; reject(new Error('Login cancelled')); };
                if (signal.aborted) return abort();
                signal.addEventListener('abort', abort, { once: true });
                login.submit = value => { signal.removeEventListener('abort', abort); login.submit = null; resolve(value); };
            });
        },
    }).then(() => { login.state = 'connected'; login.message = 'Codex 订阅已连接。'; })
        .catch(() => { login.state = controller.signal.aborted ? 'cancelled' : 'error'; login.message = controller.signal.aborted ? '登录已取消或超时。' : '登录未完成，请重试。'; })
        .finally(() => { clearTimeout(timer); login.url = ''; login.submit = null; });
    return res.json(loginSnapshot(login));
});
codexRouter.post('/callback', (req, res) => {
    if (activeLogin?.owner !== req.user.directories.root || !activeLogin.submit || activeLogin.state !== 'waiting') return res.sendStatus(409);
    const code = req.body?.code;
    if (typeof code !== 'string' || !code.trim() || code.length > 8192) return res.sendStatus(400);
    activeLogin.submit(code.trim());
    return res.json({ ok: true });
});
codexRouter.post('/cancel', (req, res) => {
    if (activeLogin?.owner === req.user.directories.root) activeLogin.controller.abort();
    res.json({ ok: true });
});
codexRouter.post('/logout', async (req, res) => {
    try {
        if (activeLogin?.owner === req.user.directories.root) { activeLogin.controller.abort(); await activeLogin.task; }
        await codexRuntime(req.user.directories).models.logout(providerId);
        if (activeLogin?.owner === req.user.directories.root) activeLogin = undefined;
        res.json({ ok: true });
    } catch { res.status(500).json({ error: '无法移除登录信息。' }); }
});
