import { describe, expect, test } from 'bun:test';
import { canUseModel, parseAllowedModels, validateAllowedModels } from '../src/lib/modelAccess';

describe('allowed model validation', () => {
  test('null is unrestricted; an empty array denies all', () => {
    expect(validateAllowedModels(null)).toBeNull();
    expect(validateAllowedModels([])).toEqual([]);
    expect(canUseModel(null, 'any-future-model')).toBe(true);
    expect(canUseModel('[]', 'any-future-model')).toBe(false);
  });

  test('deduplicates in first-seen order without changing exact IDs', () => {
    const input = ['vendor/model:latest', 'Model', 'model', 'vendor/model:latest'];
    expect(validateAllowedModels(input)).toEqual(['vendor/model:latest', 'Model', 'model']);
    expect(input).toHaveLength(4);
    expect(parseAllowedModels(JSON.stringify(input))).toEqual(['vendor/model:latest', 'Model', 'model']);
    for (const id of ['MODEL', ' model', 'model ', 'vendor/model', 'vendor/*']) {
      expect(canUseModel('["model","vendor/model:latest"]', id)).toBe(false);
    }
    expect(canUseModel('["vendor/*"]', 'vendor/model')).toBe(false);
    expect(canUseModel('["model"]', 'model')).toBe(true);
  });

  const invalid: unknown[] = [undefined, true, 1, {}, 'model', '', [''], [' '], ['\t'],
    [' model'], ['model '], [null], [123], [{}], [['model']], ['valid', false], ['x'.repeat(201)],
    Array.from({ length: 1001 }, () => 'duplicate')];
  for (const [index, value] of invalid.entries()) {
    test(`rejects invalid admin value ${index}`, () => {
      expect(() => validateAllowedModels(value)).toThrow();
      try { validateAllowedModels(value); } catch (error: any) {
        expect(error.status).toBe(400);
        expect(error.param).toBe('allowed_models');
      }
    });
  }

  test('accepts exact inclusive size limits', () => {
    expect(validateAllowedModels(['x'.repeat(200)])).toEqual(['x'.repeat(200)]);
    const ids = Array.from({ length: 1000 }, (_, i) => `model-${i}`);
    expect(validateAllowedModels(ids)).toEqual(ids);
  });

  for (const raw of ['', '{', 'null', 'true', '1', '"model"', '{}', '[null]', '["ok",1]',
    '[" model"]', JSON.stringify(['x'.repeat(201)]), JSON.stringify(Array(1001).fill('model'))]) {
    test(`corrupt stored policy fails closed: ${raw.slice(0, 35)}`, () => {
      expect(parseAllowedModels(raw)).toEqual([]);
      expect(canUseModel(raw, 'ok')).toBe(false);
      expect(canUseModel(raw, 'model')).toBe(false);
    });
  }
});
