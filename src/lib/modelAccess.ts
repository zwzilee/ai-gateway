/** 下游密钥按模型 ID 精确授权；null 不限制，空数组禁止全部模型。 */
import { badRequest } from './errors.js';

export function validateAllowedModels(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 1000) {
    throw badRequest('allowed_models 必须是模型 ID 数组（最多 1000 个）或 null', 'allowed_models');
  }
  for (const model of value) {
    if (typeof model !== 'string' || !model.trim() || model !== model.trim() || model.length > 200) {
      throw badRequest('allowed_models 中的模型 ID 必须是无首尾空格的非空字符串，最多 200 字符', 'allowed_models');
    }
  }
  return [...new Set(value as string[])];
}

/** 存储内容损坏时拒绝访问，避免意外扩大权限。 */
export function parseAllowedModels(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? validateAllowedModels(value) : [];
  } catch {
    return [];
  }
}

export function canUseModel(raw: string | null, model: string): boolean {
  const allowed = parseAllowedModels(raw);
  return allowed === null || allowed.includes(model);
}
