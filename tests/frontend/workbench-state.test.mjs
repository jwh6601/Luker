import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyNodeEdits, validateGenerationFields, workflowStages } from '../../public/scripts/extensions/orchestrator/workbench-state.js';

test('changing a node preserves sibling presets, tool overrides, and parallel topology', () => {
    const original = {
        name: 'Custom flow',
        spec: { stages: [{ id: 'parallel', mode: 'parallel', nodes: ['planner', { id: 'review', preset: 'critic', type: 'review' }] }], customTools: { inspect: { enabled: true } } },
        presets: { planner: { systemPrompt: 'Plan', tools: { note: true }, skills: { visible: ['one'] } }, critic: { systemPrompt: 'Review', promptPresetName: 'Shared' } },
    };
    const snapshot = structuredClone(original);
    const result = applyNodeEdits(original, new Map([['planner', { promptPresetName: 'Independent' }]]));
    assert.deepEqual(original, snapshot);
    assert.deepEqual(result.spec, original.spec);
    assert.deepEqual(result.presets.critic, original.presets.critic);
    assert.deepEqual(result.presets.planner.tools, original.presets.planner.tools);
    assert.deepEqual(result.presets.planner.skills, original.presets.planner.skills);
    assert.equal(result.presets.planner.promptPresetName, 'Independent');
});

test('missing nodes and unsupported writes are rejected instead of rebuilding the flow', () => {
    const profile = { presets: { planner: {} } };
    assert.throws(() => applyNodeEdits(profile, new Map([['removed', { promptPresetName: 'X' }]])));
    assert.throws(() => applyNodeEdits(profile, new Map([['planner', { tools: {} }]])));
    assert.deepEqual(profile, { presets: { planner: {} } });
});

test('custom node IDs and distinct node/preset identities survive presentation', () => {
    const spec = { stages: [{ id: 'custom', mode: 'parallel', nodes: ['original', { id: 'second', preset: 'reused' }] }] };
    const stages = workflowStages(spec);
    assert.equal(stages[0].parallel, true);
    assert.equal(stages[0].nodes[1].id, 'second');
    assert.equal(stages[0].nodes[1].preset, 'reused');
    assert.equal(stages[0].nodes[0].title, 'original');
    assert.equal(spec.stages[0].nodes[0], 'original');
});

test('invalid generation limits cannot be silently saved', () => {
    for (const value of ['', '0', '-1', '1.5', 'Infinity', '2000001']) {
        assert.throws(() => validateGenerationFields('high', value));
    }
    assert.throws(() => validateGenerationFields('unrecognized', 2000));
    assert.deepEqual(validateGenerationFields('high', '2000'), { reasoning_effort: 'high', openai_max_tokens: 2000 });
});
