import { readFile, readdir } from 'node:fs/promises';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const requiredStates = ['Default', 'Loading', 'Disabled', 'Error'];

describe('UX-001 component stories', () => {
  it('has all four required states for every shared TSX component', async () => {
    const components = (await readdir(new URL('packages/ui/src/', root)))
      .filter((name) => name.endsWith('.tsx'));
    expect(components.length).toBeGreaterThan(0);

    for (const component of components) {
      const storyName = component.replace(/\.tsx$/, '.stories.tsx');
      const story = await readFile(new URL(`apps/web/stories/${storyName}`, root), 'utf8');
      const source = ts.createSourceFile(storyName, story, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const exports = source.statements.flatMap((statement) => {
        if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
        return statement.declarationList.declarations.map((declaration) => declaration.name.getText(source));
      });
      expect(exports, `${storyName} must show default, loading, disabled, and error`).toEqual(expect.arrayContaining(requiredStates));
    }
  });
});
