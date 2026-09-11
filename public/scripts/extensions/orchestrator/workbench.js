// SPDX-License-Identifier: AGPL-3.0-or-later
// A presentation layer over Luker's existing settings and preset APIs.
import { loadGlobalEditorState } from './editor-state.js';
import { openConnectionManager, selectWriterConnection } from '../connection-manager/workbench-connections.js';
import { toEditablePresetMap, toEditableSpec } from './editable-spec.js';
import { getActivePresetId, getPreset, listPresets, setActivePresetId, writeActivePreset } from './preset-library.js';
import { renderConnectionProfileOptions, renderOpenAIPresetOptions } from './agent-resolution.js';
import { applyNodeEdits, describeNode, validateGenerationFields, workflowStages } from './workbench-state.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
}[char]));
const icon = name => `<i class="fa-solid fa-${name}" aria-hidden="true"></i>`;
const ctx = () => Luker.getContext();
const settings = () => ctx().extensionSettings.orchestrator;
let mounted = false;
let panel;
let editor;
let baseline;
let selected = 'planner';
let enabled;
let activeId;
let page = 'models';
let dirty = false;
let saving = false;
let parameterEdits = new Map();
let nodeEdits = new Map();
let refreshNative;
let effectiveProfile;

function say(message, error = false) {
    const status = document.querySelector('#wb-status');
    if (status) { status.textContent = message; status.classList.toggle('wb-error', error); }
}

function resetDraft() {
    editor = loadGlobalEditorState();
    baseline = structuredClone(settings());
    enabled = Boolean(settings().enabled);
    activeId = getActivePresetId(settings(), 'spec');
    parameterEdits = new Map();
    nodeEdits = new Map();
    dirty = false;
}

function markDirty() {
    dirty = true;
    say('有尚未保存的修改');
}

function editNode(field, value) {
    editor.presets[selected][field] = value;
    nodeEdits.set(selected, { ...nodeEdits.get(selected), [field]: value });
    markDirty();
}

function mayLeave() {
    return !saving && (!dirty || window.confirm('修改还没有保存，放弃这些修改？'));
}

function openNative(drawer) {
    if (!mayLeave()) return false;
    dirty = false;
    if (!drawer) page = 'story';
    document.body.classList.add('wb-native');
    updateNavigation();
    // Use the original drawer controls so their lifecycle and state stay intact.
    for (const toggle of document.querySelectorAll('#top-settings-holder > .drawer > .drawer-toggle')) {
        if (toggle.parentElement.querySelector(':scope > .drawer-content.openDrawer')) toggle.click();
    }
    const target = drawer ? document.getElementById(drawer) : null;
    target?.querySelector(':scope > .drawer-toggle')?.click();
    return true;
}

function openAdvanced() {
    if (!openNative('extensions-settings-button')) return;
    refreshNative();
    document.querySelector('#orchestrator_settings [data-luker-action="open-orch-editor-popup"]')?.click();
}

function updateNavigation() {
    document.querySelectorAll('[data-wb-nav]').forEach(button => {
        const active = button.dataset.wbNav === page;
        button.classList.toggle('wb-active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    });
}

function header(title, subtitle) {
    const character = ctx().characters?.[ctx().characterId];
    return `<header class="wb-header"><div><h1>${title}</h1><p>${subtitle}</p></div>
        <div class="wb-story-context"><span>当前故事：${escape(character?.name || '尚未选择')}</span>
        <button class="wb-button" data-wb-action="story">返回故事</button></div></header>`;
}

function currentParameters(preset) {
    const context = ctx();
    const name = preset?.promptPresetName || settings().llmNodePresetName;
    const character = context.characters?.[context.characterId];
    const embedded = character && name ? context.character?.presets?.resolveByName(character, name) : null;
    const stored = embedded?.preset || context.openai.settings[context.openai.settingNames[name]];
    return structuredClone(stored || context.chatCompletionSettings);
}

function modelFor(preset) {
    const name = preset?.apiPresetName || settings().llmNodeApiPresetName;
    const profiles = ctx().extensionSettings.connectionManager?.profiles || [];
    const profile = profiles.find(item => item.name === name && item.mode === 'cc');
    return profile?.model || (name ? '连接中指定的模型' : ctx().getChatCompletionModel?.() || '沿用当前对话模型');
}

function flowHtml() {
    const stages = workflowStages(editor.spec);
    return `<section class="wb-card wb-flow"><div class="wb-card-heading"><h2>生成流程</h2><span class="wb-badge">${enabled ? stages.length + 1 : 1} 个阶段</span></div>
        <div class="wb-steps">${enabled ? stages.map(stage => `<div class="wb-stage">
            ${stage.nodes.map((node, index) => `<button class="wb-step ${selected === node.preset ? 'wb-selected' : ''}" data-wb-node="${escape(node.preset)}" aria-pressed="${selected === node.preset}">
                <span class="wb-number">${index ? icon('code-branch') : stage.number}</span><span class="wb-step-text"><strong>${escape(node.title)}</strong>
                <span>${escape(node.description)}</span><small>${escape(editor.presets[node.preset]?.apiPresetName || '沿用默认配置')}${stage.parallel ? ' · 同阶段并行' : ''}</small></span></button>`).join('')}
            <div class="wb-arrow">${icon('arrow-down')}</div></div>`).join('') : ''}
            <button class="wb-step ${selected === '__writer' ? 'wb-selected' : ''}" data-wb-node="__writer" aria-pressed="${selected === '__writer'}"><span class="wb-number">${enabled ? stages.length + 1 : 1}</span>
                <span class="wb-step-text"><strong>正文生成</strong><span>将${enabled ? '规划写成' : '故事继续写成'}可阅读的正文</span><small>沿用对话模型</small></span></button>
        </div></section>`;
}

function detailHtml() {
    if (selected === '__writer') return `<section class="wb-card wb-detail"><span class="wb-eyebrow">正在配置</span><h2>正文生成</h2><p class="wb-muted">使用当前对话的模型与参数</p>
        <div class="wb-info">${icon('circle-info')}<div><strong>正文沿用 Luker 对话配置</strong><p>连接、模型和正文预设均在原有配置中管理。</p></div></div>
        <label for="wb-writer-api">正文连接（选择后立即应用）</label><select id="wb-writer-api">${renderConnectionProfileOptions(ctx().extensionSettings.connectionManager?.profiles?.find(item => item.id === ctx().extensionSettings.connectionManager.selectedProfile)?.name || '', '选择已保存的连接')}</select>
        <div class="wb-writer-actions"><button class="wb-button" data-wb-action="connections">${icon('plug')} 管理连接</button><button class="wb-button" data-wb-native="ai-config-button">${icon('sliders')} 调整正文参数</button></div>
        ${saveFooter()}</section>`;
    const preset = editor.presets[selected];
    if (!preset) return '<section class="wb-card wb-detail"><h2>选择一个环节</h2></section>';
    const params = { ...currentParameters(preset), ...parameterEdits.get(selected) };
    const effort = params.reasoning_effort || 'auto';
    const title = describeNode(selected)[0];
    const shared = workflowStages(editor.spec).flatMap(stage => stage.nodes).filter(node => node.preset === selected).length > 1;
    return `<section class="wb-card wb-detail"><span class="wb-eyebrow">正在配置</span><h2>${escape(title)}</h2><p class="wb-muted">这些设置用于全局方案中的当前环节</p>
        <form id="wb-node-form"><div class="wb-fields">
            <label for="wb-api">API 连接</label><select id="wb-api">${renderConnectionProfileOptions(preset.apiPresetName, '沿用默认连接')}</select>
            <span class="wb-field-label">模型</span><div class="wb-model"><span>${escape(modelFor(preset))}</span><button type="button" class="wb-link" data-wb-action="connections">管理连接</button></div>
            <span class="wb-field-label" id="wb-effort-label">推理等级</span><div class="wb-effort" role="group" aria-labelledby="wb-effort-label">${[['auto', '默认'], ['low', '低'], ['medium', '中'], ['high', '高']].map(([value, label]) => `<button type="button" data-wb-effort="${value}" aria-pressed="${effort === value}" class="${effort === value ? 'wb-chosen' : ''}">${label}</button>`).join('')}</div>
            <label for="wb-tokens">最大输出长度</label><div class="wb-token-field"><input id="wb-tokens" type="number" min="1" max="2000000" step="1" value="${escape(params.openai_max_tokens ?? 2048)}" required><span>tokens</span></div>
        </div>
        <details class="wb-advanced"><summary>高级参数 ${icon('chevron-right')}</summary><div>
            <label for="wb-prompt-preset">参数与提示词预设</label><select id="wb-prompt-preset">${renderOpenAIPresetOptions(ctx(), preset.promptPresetName, '沿用默认预设')}</select>
            <label for="wb-effort">完整推理等级</label><select id="wb-effort">${[['auto', '默认'], ['min', '最少'], ['low', '低'], ['medium', '中'], ['high', '高'], ['max', '最高']].map(([value, label]) => `<option value="${value}" ${effort === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
            <p class="wb-muted">推理等级和输出上限是否受支持，由所选模型决定。</p>
            <label for="wb-system">环节系统指令</label><textarea id="wb-system" rows="5">${escape(preset.systemPrompt)}</textarea>
            <button type="button" class="wb-link" data-wb-action="advanced">打开完整流程编辑器 ${icon('arrow-up-right-from-square')}</button>
        </div></details>
        <div class="wb-info">${icon('circle-info')}<div><strong>${shared ? '多个节点共用此环节预设' : '本环节独立配置'}</strong><p>${shared ? '修改会应用于共用此预设的节点。需要拆分时，请使用完整流程编辑器。' : '修改推理等级或输出长度时，保存为本环节的独立参数预设。'}</p></div></div>
        ${saveFooter()}</form></section>`;
}

function saveFooter() {
    return `<footer class="wb-save-row"><span id="wb-status" role="status" aria-live="polite">${dirty ? '有尚未保存的修改' : ''}</span><button type="button" class="wb-link" data-wb-action="reset">撤销修改</button><button type="button" class="wb-primary" data-wb-action="save" ${saving ? 'disabled' : ''}>${saving ? '正在保存…' : '保存方案'}</button></footer>`;
}

function renderModels() {
    const scrollTop = panel.querySelector('.wb-steps')?.scrollTop || 0;
    const sameNode = panel.dataset.node === selected;
    const advancedOpen = sameNode && panel.querySelector('.wb-advanced')?.open;
    const focusedId = sameNode && panel.contains(document.activeElement) ? document.activeElement.id : '';
    const supported = settings().executionMode === 'spec';
    if (!enabled || (selected !== '__writer' && !editor.presets[selected])) selected = enabled ? Object.keys(editor.presets)[0] : '__writer';
    const options = listPresets(settings(), 'spec').map(preset => `<option value="${escape(preset.id)}" ${preset.id === activeId ? 'selected' : ''}>${escape(preset.name === 'Default' ? '默认方案' : preset.name)}</option>`).join('');
    const profile = effectiveProfile(ctx());
    panel.innerHTML = `${header('模型与流程', '让每个环节使用合适的模型')}
        <div class="wb-toolbar"><div class="wb-mode" role="group" aria-label="生成方式"><button data-wb-mode="direct" class="${!enabled ? 'wb-chosen' : ''}" aria-pressed="${!enabled}">直接生成</button><button data-wb-mode="multi" class="${enabled ? 'wb-chosen' : ''}" aria-pressed="${enabled}">多步协作</button></div>
        <label for="wb-plan">运行方案</label><select id="wb-plan" ${!supported ? 'disabled' : ''}>${options}</select><span class="wb-scope">全局方案</span></div>
        <p class="wb-explainer">${enabled ? '按顺序处理情境、规划和检查，再生成正文。' : '直接使用当前对话模型生成正文。多步协作可为不同环节选择独立配置。'}</p>
        ${profile.source === 'character' ? '<div class="wb-notice">当前故事启用了独立流程。这里编辑的是全局方案；故事专属配置请在完整流程编辑器中调整。</div>' : ''}
        ${!supported ? `<div class="wb-card wb-unsupported"><h2>当前使用 ${escape(settings().executionMode)} 流程</h2><p>此类流程请使用原有编辑器配置；工作台不会转换已有方案。</p><button class="wb-button" data-wb-action="advanced">打开完整流程编辑器</button></div>` : `<div class="wb-grid">${flowHtml()}${detailHtml()}</div>`}`;
    panel.dataset.node = selected;
    const steps = panel.querySelector('.wb-steps');
    const node = steps?.querySelector('.wb-selected');
    if (steps) {
        steps.scrollTop = scrollTop;
        if (node) {
            const offset = node.getBoundingClientRect().top - steps.getBoundingClientRect().top;
            if (offset < 0) steps.scrollTop += offset;
            else if (offset + node.offsetHeight > steps.clientHeight) steps.scrollTop += offset + node.offsetHeight - steps.clientHeight;
        }
    }
    if (advancedOpen && panel.querySelector('.wb-advanced')) panel.querySelector('.wb-advanced').open = true;
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
}

function renderLibrary(filter = '') {
    const characters = (ctx().characters || []).map((character, index) => ({ character, index }))
        .filter(({ character }) => character.name.toLowerCase().includes(filter.toLowerCase()));
    panel.innerHTML = `${header('故事库', '选择一个故事，继续你的旅程')}
        <div class="wb-library-toolbar"><input id="wb-search" placeholder="搜索故事…" aria-label="搜索故事" value="${escape(filter)}"><button class="wb-primary" data-wb-native="rightNavHolder">${icon('plus')} 导入或新建故事</button></div>
        ${characters.length ? `<div class="wb-library">${characters.map(({ character, index }) => `<button class="wb-story-card" data-wb-character="${index}"><img src="${escape(ctx().getThumbnailUrl('avatar', character.avatar))}" alt="" loading="lazy"><div><h2>${escape(character.name)}</h2><p>${escape(String(character.description || '').replace(/<[^>]*>/g, '').slice(0, 100)) || '打开故事，开始对话'}</p><span>进入故事 ${icon('arrow-right')}</span></div></button>`).join('')}</div>` : `<section class="wb-card wb-empty">${icon('book-open')}<h2>${filter ? '没有找到相关故事' : '你的下一个故事，从这里开始'}</h2><p>${filter ? '试试其他名称。' : '导入已有角色卡，或新建一个属于你的故事。'}</p><button class="wb-button" data-wb-native="rightNavHolder">打开故事管理</button></section>`}`;
}

function renderSettings() {
    const cards = [
        ['plug', '连接与模型', '管理 API 连接、模型来源和连接方案。', 'sys-settings-button', '管理连接'],
        ['sliders', '正文生成', '调整正文使用的提示词预设与生成参数。', 'ai-config-button', '调整参数'],
        ['puzzle-piece', '扩展与流程', '管理已安装扩展，或使用完整流程编辑器。', 'extensions-settings-button', '管理扩展'],
        ['gear', '使用偏好', '调整语言、聊天显示、账号和其他偏好。', 'user-settings-button', '打开完整设置'],
    ];
    panel.innerHTML = `${header('设置', '管理连接、扩展与使用偏好')}<div class="wb-settings-grid">${cards.map(([glyph, title, description, drawer, action]) => `<section class="wb-card wb-setting-card"><span class="wb-setting-icon">${icon(glyph)}</span><h2>${title}</h2><p>${description}</p><button class="wb-button" data-wb-native="${drawer}">${action} ${icon('arrow-right')}</button></section>`).join('')}</div>`;
}

function navigate(destination) {
    if (destination === 'story') { openNative(''); return; }
    if (!mayLeave()) return;
    document.body.classList.remove('wb-native');
    page = destination;
    resetDraft();
    updateNavigation();
    if (page === 'library') renderLibrary();
    else if (page === 'settings') renderSettings();
    else renderModels();
}

async function verifySaved(expected) {
    // Core saveSettings currently reports errors via a toast instead of throwing.
    // Read back the saved namespace before claiming success in this new editor.
    const response = await fetch('/api/settings/get', { method: 'POST', headers: ctx().getRequestHeaders(), body: '{}', cache: 'no-store' });
    if (!response.ok) throw new Error('无法确认保存结果，请检查本机服务后重试。');
    const data = await response.json();
    const payload = typeof data.settings === 'string' ? JSON.parse(data.settings) : data.settings;
    const actual = payload?.extension_settings?.orchestrator;
    if (actual?.enabled !== expected.enabled || actual?.activePresetIds?.spec !== expected.activePresetIds?.spec
        || JSON.stringify(actual?.presetLibraries?.spec) !== JSON.stringify(expected.presetLibraries?.spec)) {
        throw new Error('保存未得到确认，修改仍保留在编辑器中。');
    }
}

async function save() {
    if (saving || settings().executionMode !== 'spec') return;
    const form = document.getElementById('wb-node-form');
    if (form && !form.reportValidity()) return;
    // Refuse to overwrite a native-editor or chat-switch change made since opening.
    if (JSON.stringify(settings()) !== JSON.stringify(baseline)) {
        say('配置已在其他界面改变。请撤销修改后重新编辑，避免覆盖新配置。', true);
        return;
    }
    saving = true;
    panel.inert = true;
    panel.setAttribute('aria-busy', 'true');
    renderModels();
    const before = structuredClone(settings());
    const edits = new Map([...nodeEdits].map(([id, fields]) => [id, { ...fields }]));
    try {
        for (const [id, changes] of parameterEdits) {
            const body = { ...currentParameters(editor.presets[id]), ...changes };
            const fields = validateGenerationFields(body.reasoning_effort || 'auto', body.openai_max_tokens);
            const name = `工作台 · ${describeNode(id)[0]} · ${crypto.randomUUID().slice(0, 8)}`;
            await ctx().openai.savePreset(name, { ...body, ...fields }, false);
            edits.set(id, { ...edits.get(id), promptPresetName: name });
        }
        if (!setActivePresetId(settings(), 'spec', 'global', activeId)) {
            throw new Error('当前方案已不存在，请重新选择方案。');
        }
        const original = getPreset(settings(), 'spec', 'global', activeId);
        const result = writeActivePreset(settings(), 'spec', 'global', applyNodeEdits(original, edits));
        if (!result.ok) throw new Error('当前方案已不存在，请重新选择方案。');
        settings().enabled = enabled;
        const expected = structuredClone(settings());
        await ctx().saveSettings();
        await verifySaved(expected);
        resetDraft();
        refreshNative();
        renderModels();
        say('方案已保存');
    } catch (error) {
        Object.assign(settings(), before);
        renderModels();
        say(error.message || '保存失败，请稍后重试。', true);
    } finally {
        saving = false;
        panel.inert = false;
        panel.removeAttribute('aria-busy');
        document.querySelector('[data-wb-action="save"]')?.removeAttribute('disabled');
        const button = document.querySelector('[data-wb-action="save"]');
        if (button) button.textContent = '保存方案';
    }
}

function changeEffort(value) {
    parameterEdits.set(selected, { ...parameterEdits.get(selected), reasoning_effort: value });
    markDirty();
    renderModels();
    panel.querySelector(`[data-wb-effort="${CSS.escape(value)}"]`)?.focus({ preventScroll: true });
}

export function mountWorkbench({ refresh, getEffectiveProfile }) {
    if (mounted) return;
    mounted = true;
    refreshNative = refresh;
    effectiveProfile = getEffectiveProfile;
    const style = document.createElement('link');
    style.rel = 'stylesheet'; style.href = '/css/luker-workbench.css'; document.head.append(style);
    document.body.classList.add('luker-workbench');
    const sidebar = document.createElement('aside');
    sidebar.id = 'wb-sidebar';
    sidebar.innerHTML = `<a class="wb-brand" href="#" aria-label="Luker 故事工作台">${icon('book-open')}<span><strong>Luker</strong><small>故事工作台</small></span></a>
        <nav aria-label="主导航">${[['library', 'file-lines', '故事库'], ['story', 'list', '当前故事'], ['models', 'diagram-project', '模型与流程'], ['settings', 'gear', '设置']].map(([id, glyph, label]) => `<button data-wb-nav="${id}">${icon(glyph)}<span>${label}</span></button>`).join('')}</nav>
        <div class="wb-service"><span class="wb-dot"></span><span id="wb-service-label">本机服务已连接</span></div>`;
    panel = document.createElement('main'); panel.id = 'wb-main';
    document.body.append(sidebar, panel);
    resetDraft(); renderModels(); updateNavigation();
    sidebar.addEventListener('click', event => {
        const button = event.target.closest('[data-wb-nav]');
        if (button) navigate(button.dataset.wbNav);
        if (event.target.closest('.wb-brand')) { event.preventDefault(); navigate('library'); }
    });
    panel.addEventListener('click', async event => {
        const button = event.target.closest('button');
        if (!button || saving) return;
        if (button.dataset.wbNode) { selected = button.dataset.wbNode; renderModels(); }
        if (button.dataset.wbAction === 'connections' || button.dataset.wbNative === 'sys-settings-button') {
            openConnectionManager(() => { if (page === 'models') renderModels(); });
            return;
        }
        if (button.dataset.wbNative !== undefined) openNative(button.dataset.wbNative);
        if (button.dataset.wbEffort) changeEffort(button.dataset.wbEffort);
        if (button.dataset.wbMode) {
            if (settings().executionMode !== 'spec') { openAdvanced(); return; }
            enabled = button.dataset.wbMode === 'multi';
            selected = enabled ? 'planner' : '__writer'; markDirty(); renderModels();
        }
        if (button.dataset.wbAction === 'reset' && mayLeave()) { resetDraft(); renderModels(); }
        if (button.dataset.wbAction === 'save') await save();
        if (button.dataset.wbAction === 'advanced') openAdvanced();
        if (button.dataset.wbAction === 'story') navigate('story');
        if (button.dataset.wbCharacter !== undefined) {
            await ctx().selectCharacterById(Number(button.dataset.wbCharacter), { switchMenu: false });
            openNative('');
        }
    });
    panel.addEventListener('input', event => {
        if (event.target.id === 'wb-search') {
            const value = event.target.value; const position = event.target.selectionStart;
            renderLibrary(value); const input = document.getElementById('wb-search'); input.focus(); input.setSelectionRange(position, position);
        }
        if (event.target.id === 'wb-tokens') {
            parameterEdits.set(selected, { ...parameterEdits.get(selected), openai_max_tokens: event.target.value }); markDirty();
        }
        if (event.target.id === 'wb-system') editNode('systemPrompt', event.target.value);
    });
    panel.addEventListener('change', async event => {
        if (event.target.id === 'wb-writer-api') {
            event.target.disabled = true;
            try { await selectWriterConnection(event.target.value); renderModels(); say('正文连接已应用并保存'); } catch (error) { say(error.message, true); event.target.disabled = false; }
            return;
        }
        if (event.target.id === 'wb-api') { editNode('apiPresetName', event.target.value); renderModels(); }
        if (event.target.id === 'wb-prompt-preset') { editNode('promptPresetName', event.target.value); parameterEdits.delete(selected); renderModels(); }
        if (event.target.id === 'wb-effort') changeEffort(event.target.value);
        if (event.target.id === 'wb-plan') {
            if (!mayLeave()) { event.target.value = activeId; return; }
            const chosen = getPreset(settings(), 'spec', 'global', event.target.value);
            if (!chosen) { say('该方案已不存在。', true); return; }
            activeId = event.target.value;
            const presets = toEditablePresetMap(chosen.presets);
            editor = { presets, spec: toEditableSpec(chosen.spec, presets) };
            parameterEdits.clear();
            nodeEdits.clear();
            markDirty(); renderModels();
        }
    });
    panel.addEventListener('submit', event => { event.preventDefault(); void save(); });
    window.addEventListener('beforeunload', event => { if (dirty || saving) { event.preventDefault(); event.returnValue = ''; } });
    ctx().eventSource.on(ctx().eventTypes.CHAT_CHANGED, () => {
        if (page === 'models' && dirty) say('故事已切换；未保存的全局方案修改仍保留在这里。');
        else if (page === 'models') { resetDraft(); renderModels(); }
        if (page === 'library') renderLibrary();
    });
    const updateConnection = async () => {
        const label = document.getElementById('wb-service-label');
        let connected = false;
        try {
            const response = await fetch('/api/ping', { method: 'POST', headers: ctx().getRequestHeaders(), signal: AbortSignal.timeout(5000) });
            connected = response.ok;
        } catch { /* Show local-service status, independently of Internet connectivity. */ }
        label.textContent = connected ? '本机服务已连接' : '本机服务未连接';
        sidebar.classList.toggle('wb-offline', !connected);
    };
    void updateConnection();
    window.addEventListener('focus', updateConnection);
    window.addEventListener('online', updateConnection); window.addEventListener('offline', updateConnection);
}
