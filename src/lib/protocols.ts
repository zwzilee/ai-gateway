/**
 * 上游协议的识别与判定。
 *
 * 渠道可以在后台声明 `capabilities`（空格分隔），告诉网关它原生会说哪几种协议：
 *
 *   chat        OpenAI Chat Completions（默认；老渠道不写 capability 就是这一档）
 *   responses   OpenAI Responses
 *   anthropic   Anthropic Messages
 *
 * 这个声明是「更强的那条路」，不是唯一的路：没声明 responses / anthropic 的渠道
 * 仍然可以是候选，由调用方把请求翻译成 chat 再翻回去。因此声明错了不会让渠道
 * 直接不可用，只是白走一趟翻译。
 *
 * 真正的判定发生在各处 route 钩子里（见 routes/openai.ts）：
 *
 *   * 下游 /v1/responses：渠道声明 responses → 原样打原生；否则翻译成 chat；
 *   * 下游 /v1/messages： 渠道声明 anthropic → 原样打原生；否则翻译成 chat；
 *   * 下游 chat：         渠道声明 chat → 原样打 chat；
 *                        只声明 responses / anthropic 的渠道 → 反向降级（见
 *                        responses.ts 的 toChatRequest、anthropic.ts 的同名函数）。
 *
 * 同名模型挂在协议不同的多个上游上时，能力声明决定「先试谁」，路由结果决定
 * 「能不能用」，两者都不依赖模型名 —— 这就是按渠道、而不是按模型分协议。
 */

import type { ChannelRow } from '../types.js';

/** 已知能力，顺序即后台下拉与展示顺序 */
export const CAPABILITY_ORDER = ['anthropic', 'responses', 'chat'] as const;

export type Capability = (typeof CAPABILITY_ORDER)[number];

const KNOWN_CAPABILITIES = new Set<string>(CAPABILITY_ORDER);

/** 别名归一：历史/手填的各种写法都映射到三种标准能力上 */
function normalize(token: string): string | null {
  switch (token) {
    case 'chat':
    case 'openai-chat':
    case 'chat-completions':
      return 'chat';
    case 'responses':
    case 'openai-responses':
    case 'response':
      return 'responses';
    case 'anthropic':
    case 'claude':
    case 'messages':
    case 'anthropic-messages':
      return 'anthropic';
    default:
      return null;
  }
}

/**
 * channels.capabilities → 能力集合。
 *
 * 空串 / NULL 表示「只有 chat」：历史上所有渠道都是这一档，老数据不需要迁移，
 * 行为与升级前完全一致（不声明 = 翻译路径）。
 */
export function channelProtocols(channel: Pick<ChannelRow, 'capabilities'>): Set<string> {
  const raw = (channel.capabilities ?? '').trim().toLowerCase();
  if (raw === '') return new Set(['chat']);
  const out = new Set<string>();
  for (const token of raw.split(/[\s,]+/)) {
    if (token === '') continue;
    const name = normalize(token);
    if (name) out.add(name);
  }
  if (out.size === 0) out.add('chat');
  return out;
}

/** 后台输入 → 规范化的能力串（按 CAPABILITY_ORDER 排序，未知值丢弃） */
export const parseCapabilities = normalizeCapabilities;

export function normalizeCapabilities(raw: unknown): string {
  const tokens: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const part of value.split(/[\s,]+/)) tokens.push(part.toLowerCase());
    } else if (Array.isArray(value)) {
      for (const item of value) push(item);
    }
  };
  push(raw);
  const found = new Set<string>();
  for (const token of tokens) {
    if (token === '') continue;
    const name = normalize(token);
    if (name && KNOWN_CAPABILITIES.has(name)) found.add(name);
  }
  return CAPABILITY_ORDER.filter((name) => found.has(name)).join(' ');
}

/**
 * 上游回复是不是「你该用另一个端点」。
 *
 * 只认明确指向协议/端点的说法，普通的 400（参数错、内容违规）不算 —— 那种
 * 换渠道重投只会把同一个错误再吃一遍，还白花一次额度。
 */
const WRONG_PROTOCOL_RE =
  /请改用|does not support \/v1\/(?:responses|chat\/completions|messages)|please use \/v1\/(?:responses|chat\/completions|messages)|only supports? \/v1\/(?:responses|chat\/completions)|不支持 \/v1\/(?:responses|chat\/completions|messages)/i;

export function mentionsOtherEndpoint(body: string): boolean {
  return WRONG_PROTOCOL_RE.test((body || '').slice(0, 4000));
}

/**
 * 上游体看起来是「用错端点」时给出原因，否则 null（视为真正的调用方错误）。
 *
 * 只给协议之间的切换用：chat → responses、chat → messages 这类降级路径可能被
 * 只认原生端点的上游拒绝，拒绝理由里会点名它要哪个端点。普通的 400（参数错、
 * 内容违规）不算 —— 那种换渠道重投只会把同一个错误再吃一遍，还白花一次额度。
 */
export function protocolMismatch(status: number, body: string): string | null {
  if (status !== 400 && status !== 404 && status !== 415) return null;
  if (!mentionsOtherEndpoint(body)) return null;
  const match = /\/v1\/(responses|messages)/i.exec(body);
  return match ? `要求改用 /v1/${(match[1] ?? '').toLowerCase()}` : '要求改用原生端点';
}
