import { describe, it, expect } from 'vitest';
import { allTools } from '../src/tools/index.js';
import { EXPECTED_ANNOTATIONS } from './fixtures/tool-annotations.js';
import { inProcessServer } from './helpers/server-handlers.js';

describe('tool annotations', () => {
  it('every tool definition declares a title and the intended annotations', () => {
    expect(allTools.map((t) => t.name)).toEqual(Object.keys(EXPECTED_ANNOTATIONS));
    for (const tool of allTools) {
      expect(tool.title, `${tool.name} title`).toMatch(/\S/);
      expect(tool.annotations, `${tool.name} annotations`).toEqual(EXPECTED_ANNOTATIONS[tool.name]);
    }
  });

  it('tools/list emits title + annotations (with the same title) for every tool', async () => {
    const server = await inProcessServer({ AIRBRAKE_USER_TOKEN: 'tok' });
    const tools = await server.listTools();
    expect(tools.map((t) => t.name)).toEqual(Object.keys(EXPECTED_ANNOTATIONS));
    for (const t of tools) {
      expect(t.title, `${t.name} title`).toMatch(/\S/);
      expect(t.annotations, `${t.name} annotations`).toEqual({
        title: t.title,
        ...EXPECTED_ANNOTATIONS[t.name],
      });
    }
  });
});
