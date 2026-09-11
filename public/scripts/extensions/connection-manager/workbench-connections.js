// SPDX-License-Identifier: AGPL-3.0-or-later
import { writeSecret, SECRET_KEYS } from '../../secrets.js';
import { applyConnectionProfile, renderConnectionProfiles } from './index.js';

const CODEX_URL = 'https://codex.luker.invalid';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[char]));
const context = () => Luker.getContext();
const connections = () => context().extensionSettings.connectionManager;
const api = async (route, body = {}) => {
    const response = await fetch(`/api/backends/chat-completions/codex/${route}`, { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '操作失败，请重试。');
    return data;
};
const refreshNative = () => {
    const select = document.getElementById('connection_profiles');
    if (select) renderConnectionProfiles(select);
};

async function persist() {
    await context().saveSettings();
    const response = await fetch('/api/settings/get', { method: 'POST', headers: context().getRequestHeaders(), body: '{}', cache: 'no-store' });
    if (!response.ok) throw new Error('无法确认连接是否保存，请重试。');
    const data = await response.json();
    const settings = typeof data.settings === 'string' ? JSON.parse(data.settings) : data.settings;
    if (JSON.stringify(settings.extension_settings?.connectionManager) !== JSON.stringify(connections())) throw new Error('连接尚未保存成功，请重试。');
    refreshNative();
}

export async function selectWriterConnection(name, model) {
    const profile = connections().profiles.find(item => item.name === name && item.mode === 'cc');
    if (!profile) throw new Error('请选择已保存的连接。');
    if (!String(model || '').trim()) throw new Error('请先选择正文模型。');
    await applyConnectionProfile({ ...profile, model: String(model).trim(), 'custom-models': JSON.stringify([String(model).trim()]) });
    connections().selectedProfile = profile.id;
    await persist();
    await context().eventSource.emit(context().eventTypes.CONNECTION_PROFILE_LOADED, profile.name);
}

export function openConnectionManager(onChanged = () => {}) {
    const dialog = document.createElement('dialog');
    dialog.className = 'wb-connections';
    let status;
    let polling;
    let editingId = '';
    let busy = false;
    dialog.innerHTML = `<header><div><h2>连接管理</h2><p>先保存连接，再为各个环节选择。</p></div><button type="button" data-action="close" aria-label="关闭">×</button></header>
        <div class="wb-connection-layout"><section><h3>已保存的连接</h3><div id="wb-connection-list"></div><button class="wb-button" data-action="new">＋ 添加连接</button></section>
        <form id="wb-connection-form"><h3 id="wb-connection-title">添加连接</h3>
        <label>连接名称<input id="wb-connection-name" required maxlength="80" placeholder="例如：正文用 DeepSeek"></label>
        <label>连接类型<select id="wb-connection-type"><option value="custom">API Key（OpenAI 兼容）</option><option value="openai">OpenAI API</option><option value="deepseek">DeepSeek API</option><option value="claude">Claude API</option><option value="codex">Codex 订阅</option></select></label>
        <label id="wb-url-row">API 地址<input id="wb-connection-url" type="url" placeholder="https://api.example.com/v1"></label>
        <label id="wb-key-row">API Key<input id="wb-connection-key" type="password" autocomplete="new-password" placeholder="新建时填写；编辑时留空保留"></label>
        <section id="wb-codex-login" hidden><p id="wb-codex-state"></p><p>复用 DSH 的订阅接入。当前支持文本与工具调用；最大输出长度由服务端决定。</p><button type="button" class="wb-button" data-action="login">登录 Codex 订阅</button> <button type="button" class="wb-link" data-action="logout">退出订阅登录</button>
        <div id="wb-login-progress" hidden><a id="wb-login-url" target="_blank" rel="noopener noreferrer">打开登录页面</a><p>登录完成后自动更新。如果未自动返回，可粘贴浏览器回调地址。</p><input id="wb-callback" type="password" autocomplete="off" aria-label="登录回调地址"><button type="button" class="wb-button" data-action="callback">完成登录</button><button type="button" class="wb-link" data-action="cancel">取消登录</button></div></section>
        <p>模型、推理等级和输出参数在 pipeline 的各个环节中选择。</p>
        <p id="wb-connection-status" role="status" aria-live="polite"></p><button type="submit" class="wb-primary">保存连接</button></form></div>`;
    document.body.append(dialog);
    const $ = selector => dialog.querySelector(selector);
    const message = text => { $('#wb-connection-status').textContent = text; };
    const list = () => { $('#wb-connection-list').innerHTML = (connections().profiles || []).filter(profile => profile.mode === 'cc').map(profile => `<button type="button" class="wb-saved-connection" data-edit="${escape(profile.id)}"><strong>${escape(profile.name)}</strong><small>${profile['api-url'] === CODEX_URL ? 'Codex 订阅' : 'API'}</small></button>`).join('') || '<p>尚未保存连接。</p>'; };
    const changeType = () => {
        const type = $('#wb-connection-type').value;
        $('#wb-url-row').hidden = type === 'codex';
        $('#wb-key-row').hidden = type === 'codex';
        $('#wb-codex-login').hidden = type !== 'codex';
        $('#wb-connection-url').required = type === 'custom';
    };
    const updateStatus = async () => {
        status = await api('status');
        if (!dialog.isConnected) return;
        $('#wb-codex-state').textContent = status.connected ? '已登录。多个 Codex 连接共用本机此账号。' : '尚未登录 Codex 订阅。';

        const waiting = status.login?.state === 'waiting';
        $('#wb-login-progress').hidden = !waiting;
        if (waiting && status.login.url) $('#wb-login-url').href = status.login.url;
        if (status.login) message(status.login.message);
        if (waiting && !polling) polling = setInterval(() => { void updateStatus().catch(error => { clearInterval(polling); polling = null; message(error.message); }); }, 1500);
        if (!waiting && polling) { clearInterval(polling); polling = null; }
    };
    dialog.addEventListener('close', () => { clearInterval(polling); dialog.remove(); onChanged(); });
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('change', event => { if (event.target.id === 'wb-connection-type') changeType(); });
    dialog.addEventListener('click', async event => {
        const button = event.target.closest('button');
        if (!button || busy) return;
        try {
            if (button.dataset.edit) {
                const profile = connections().profiles.find(item => item.id === button.dataset.edit);
                const type = profile['api-url'] === CODEX_URL ? 'codex' : profile.api;
                if (![...$('#wb-connection-type').options].some(option => option.value === type)) throw new Error('此连接类型请使用原有连接设置编辑。');
                editingId = profile.id;
                $('#wb-connection-title').textContent = '编辑连接';
                $('#wb-connection-name').value = profile.name;
                // Profiles are referenced by name throughout Luker. Retain that identity.
                $('#wb-connection-name').readOnly = true;
                $('#wb-connection-type').value = type;
                $('#wb-connection-url').value = type === 'codex' ? '' : profile['api-url'] || profile['base-url'] || '';
                $('#wb-connection-key').value = '';

                changeType();
            }
            if (button.dataset.action === 'new') { editingId = ''; $('#wb-connection-form').reset(); $('#wb-connection-name').readOnly = false; $('#wb-connection-title').textContent = '添加连接'; changeType(); }
            if (button.dataset.action === 'close') dialog.close();
            if (button.dataset.action === 'login') { await api('login'); await updateStatus(); }
            if (button.dataset.action === 'callback') { const code = $('#wb-callback').value; $('#wb-callback').value = ''; await api('callback', { code }); }
            if (button.dataset.action === 'cancel') { await api('cancel'); await updateStatus(); }
            if (button.dataset.action === 'logout' && window.confirm('退出后，所有 Codex 连接暂时无法生成。确认退出？')) { await api('logout'); await updateStatus(); }
        } catch (error) { message(error.message); }
    });
    dialog.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy) return;
        const before = structuredClone(connections().profiles);
        busy = true;
        $('#wb-connection-form').inert = true;
        try {
            const name = $('#wb-connection-name').value.trim();

            const type = $('#wb-connection-type').value;
            const original = connections().profiles.find(profile => profile.id === editingId);
            if (!name) throw new Error('请填写连接名称。');
            if (connections().profiles.some(profile => profile.name === name && profile.id !== editingId)) throw new Error('已有同名连接，请换一个名称。');
            const isCodex = type === 'codex';

            const key = $('#wb-connection-key').value.trim();
            const url = $('#wb-connection-url').value.trim();
            if (url && !/^https?:\/\//i.test(url)) throw new Error('API 地址须以 http:// 或 https:// 开头。');
            let secretId = original?.api === type ? original['secret-id'] || '' : '';
            if (!isCodex && key) {
                secretId = await writeSecret(SECRET_KEYS[type.toUpperCase()], key, name);
                $('#wb-connection-key').value = '';
                if (!secretId) throw new Error('密钥保存失败。');
            }
            if (!isCodex && !secretId) throw new Error('请填写此连接的 API Key。');
            const profile = { ...original, id: editingId || crypto.randomUUID(), name, mode: 'cc', api: isCodex ? 'custom' : type,
                'api-url': isCodex ? CODEX_URL : type === 'custom' ? url : '', 'base-url': type !== 'custom' && !isCodex ? url : '',
                'secret-id': isCodex ? '' : secretId, 'proxy-url': '', 'proxy-password': '', proxy: '',

                ...Object.fromEntries(['custom-include-body', 'custom-exclude-body', 'custom-include-headers'].map(field => [field, !isCodex && original?.api === type ? original[field] || '' : ''])) };
            const index = connections().profiles.findIndex(item => item.id === profile.id);
            if (index < 0) connections().profiles.push(profile); else connections().profiles[index] = profile;
            await persist();
            editingId = profile.id; $('#wb-connection-name').readOnly = true;
            list(); onChanged(); message(isCodex && !status?.connected ? '连接已保存；登录 Codex 后即可使用。' : '连接已保存，可回到各环节选择。');
        } catch (error) { connections().profiles = before; message(error.message); } finally { busy = false; $('#wb-connection-form').inert = false; }
    });
    list(); changeType(); dialog.showModal();
    void updateStatus().catch(error => message(error.message));
}
