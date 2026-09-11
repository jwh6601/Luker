/** Pure presentation helpers. The orchestrator preset library remains the owner. */
const labels = {
    distiller: ['梳理情境', '整理人物、场景和上一轮进展'],
    lorebook_reader: ['读取设定', '提取本轮需要遵守的世界设定'],
    anti_data_guard: ['叙事风格', '检查表达方式与叙事边界'],
    planner: ['剧情规划', '决定本轮推进与角色行动'],
    recall_relevance: ['回忆筛选', '找出与当前情节相关的记忆'],
    critic: ['一致性检查', '检查设定冲突与角色行为'],
    synthesizer: ['整理写作指引', '将各环节结果汇总给正文模型'],
};

export function describeNode(id) {
    return labels[id] || [String(id), '使用此方案定义的环节指令'];
}

export function workflowStages(spec) {
    return (spec?.stages || []).map((stage, index) => ({
        id: stage.id,
        number: index + 1,
        parallel: stage.mode === 'parallel',
        nodes: (stage.nodes || []).map(node => {
            const value = typeof node === 'string' ? { id: node, preset: node } : node;
            const [title, description] = describeNode(value.id);
            return { id: value.id, preset: value.preset || value.id, title, description };
        }),
    }));
}

export function validateGenerationFields(effort, maxTokens) {
    const allowed = ['auto', 'min', 'low', 'medium', 'high', 'max'];
    if (!allowed.includes(effort)) throw new Error('请选择有效的推理等级。');
    const tokens = Number(maxTokens);
    if (!Number.isInteger(tokens) || tokens < 1 || tokens > 2000000) {
        throw new Error('最大输出长度需要是 1 到 2,000,000 之间的整数。');
    }
    return { reasoning_effort: effort, openai_max_tokens: tokens };
}

/** Update only edited fields; preserve custom tools, skills and the exact topology. */
export function applyNodeEdits(profile, edits) {
    const result = structuredClone(profile);
    const allowed = new Set(['apiPresetName', 'model', 'promptPresetName', 'systemPrompt']);
    for (const [id, changes] of edits) {
        if (!Object.hasOwn(result.presets || {}, id)) throw new Error('当前环节已不存在，请重新打开方案。');
        for (const [key, value] of Object.entries(changes)) {
            if (!allowed.has(key) || typeof value !== 'string') throw new Error('环节修改包含不支持的字段。');
            result.presets[id][key] = value;
        }
    }
    return result;
}
