/**
 * Anthropic Messages 协议适配层（/v1/messages）的单元测试。
 *
 * 和 responses.test.ts 一样只测纯逻辑 + 用假上游喂 SSE，不碰网络与 D1：
 *   1. 请求翻译：Messages → chat/completions（system / 工具 / 图片 / role 归一）
 *   2. 非流式反向转换：chat.completion → message 对象
 *   3. 流式状态机：chat SSE → Anthropic 事件序列
 *   4. usage 双向换算与入口校验
 */
import { describe, expect, test } from 'bun:test';
import {
  anthropicErrorResponse,
  anthropicId,
  buildChatRequestFromAnthropic,
  chatStreamToAnthropic,
  chatToAnthropicMessage,
  extractAnthropicUsage,
  toAnthropicUsage,
  validateMessagesBody,
} from '../src/lib/anthropic';

function sseResponse(chunks: unknown[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

describe('buildChatRequestFromAnthropic', () => {
  test('system 块 + 字符串消息 → system 与 user', () => {
    const out = buildChatRequestFromAnthropic(
      { model: 'claude', system: [{ type: 'text', text: '你是香香' }], messages: [{ role: 'user', content: '在吗' }], max_tokens: 100 },
      'upstream-model',
      false,
    );
    expect(out.messages).toEqual([
      { role: 'system', content: '你是香香' },
      { role: 'user', content: '在吗' },
    ]);
    expect(out.max_tokens).toBe(100);
    expect(out.model).toBe('upstream-model');
  });

  test('max_tokens 缺失时补默认 4096，stream 只在要求时带', () => {
    const out = buildChatRequestFromAnthropic({ messages: [{ role: 'user', content: 'hi' }] }, 'm', false);
    expect(out.max_tokens).toBe(4096);
    expect(out.stream).toBeUndefined();
  });

  test('assistant 里的 tool_use 合并成 tool_calls，content 置 null', () => {
    const out = buildChatRequestFromAnthropic(
      {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: '我查一下' },
              { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '上海' } },
            ],
          },
        ],
      },
      'm',
      false,
    );
    expect(out.messages).toEqual([
      {
        role: 'assistant',
        content: '我查一下',
        tool_calls: [
          { id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } },
        ],
      },
    ]);
  });

  test('tool_result 拆成独立的 role=tool 消息', () => {
    const out = buildChatRequestFromAnthropic(
      {
        messages: [
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴 25℃' }] },
        ],
      },
      'm',
      false,
    );
    expect(out.messages).toEqual([{ role: 'tool', tool_call_id: 'toolu_1', content: '晴 25℃' }]);
  });

  test('图片块 → image_url（base64 拼 data URL）', () => {
    const out = buildChatRequestFromAnthropic(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '看图' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            ],
          },
        ],
      },
      'm',
      false,
    );
    expect(out.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]);
  });

  test('工具：有 input_schema 的保留，内建工具丢弃；tool_choice 映射', () => {
    const out = buildChatRequestFromAnthropic(
      {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: {} } },
          { type: 'computer_20241022', name: 'computer' },
        ],
        tool_choice: { type: 'any' },
      },
      'm',
      false,
    );
    expect(out.tools).toEqual([
      { type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: {} } } },
    ]);
    expect(out.tool_choice).toBe('required');
  });

  test('stop_sequences → stop 数组', () => {
    const out = buildChatRequestFromAnthropic(
      { messages: [{ role: 'user', content: 'hi' }], stop_sequences: ['STOP', 'END'] },
      'm',
      false,
    );
    expect(out.stop).toEqual(['STOP', 'END']);
  });
});

describe('usage 换算', () => {
  test('缓存读/写都算进输入，缓存读单独记 cached', () => {
    const u = extractAnthropicUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 });
    expect(u).toEqual({ promptTokens: 130, completionTokens: 5, totalTokens: 135, cachedTokens: 100, estimated: false });
  });

  test('全零 → null', () => {
    expect(extractAnthropicUsage({ input_tokens: 0, output_tokens: 0 })).toBeNull();
  });

  test('TokenUsage → Anthropic usage，cached>0 才输出缓存键', () => {
    expect(toAnthropicUsage({ promptTokens: 7, completionTokens: 3, totalTokens: 10, cachedTokens: 0, estimated: false })).toEqual({
      input_tokens: 7,
      output_tokens: 3,
    });
    expect(toAnthropicUsage({ promptTokens: 7, completionTokens: 3, totalTokens: 10, cachedTokens: 4, estimated: false }).cache_read_input_tokens).toBe(4);
  });
});

describe('chatToAnthropicMessage', () => {
  test('文本响应 → text 块 + end_turn + usage', () => {
    const out = chatToAnthropicMessage(
      {
        choices: [{ message: { role: 'assistant', content: '你好呀' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      },
      { messages: [] },
      'claude-x',
      'msg_1',
    );
    expect(out.type).toBe('message');
    expect(out.role).toBe('assistant');
    expect(out.content).toEqual([{ type: 'text', text: '你好呀' }]);
    expect(out.stop_reason).toBe('end_turn');
    expect(out.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
  });

  test('工具调用 → tool_use 块，stop_reason=tool_use', () => {
    const out = chatToAnthropicMessage(
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
      { messages: [] },
      'claude-x',
      'msg_2',
    );
    expect(out.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '上海' } }]);
    expect(out.stop_reason).toBe('tool_use');
  });

  test('finish_reason=length → stop_reason=max_tokens', () => {
    const out = chatToAnthropicMessage(
      { choices: [{ message: { content: '截断了' }, finish_reason: 'length' }] },
      { messages: [] },
      'm',
      'msg_3',
    );
    expect(out.stop_reason).toBe('max_tokens');
  });
});

describe('chatStreamToAnthropic 流式', () => {
  const base = { request: { messages: [{ role: 'user', content: 'hi' }] }, model: 'claude-x', messageId: 'msg_s', stream: true, idleMs: 5000 };

  test('事件顺序与文本增量拼接', async () => {
    const upstream = sseResponse([
      { choices: [{ delta: { content: '你' }, index: 0 }] },
      { choices: [{ delta: { content: '好呀' }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
    ]);
    const result = chatStreamToAnthropic(upstream, base);
    const text = await new Response(result.response.body).text();
    const events = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('message_start');
    expect(types).toContain('content_block_start');
    expect(types).toContain('content_block_delta');
    expect(types).toContain('content_block_stop');
    expect(types[types.length - 2]).toBe('message_delta');
    expect(types[types.length - 1]).toBe('message_stop');
    const deltas = events.filter((e) => e.type === 'content_block_delta').map((e) => (e.delta as Record<string, unknown>).text);
    expect(deltas.join('')).toBe('你好呀');
    const settled = await result.usage;
    expect(settled.usage.promptTokens).toBe(8);
    expect(settled.usage.completionTokens).toBe(2);
  });

  test('非流式折叠成整包 message JSON', async () => {
    const upstream = sseResponse([
      { choices: [{ delta: { content: '整包' }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
    ]);
    const result = chatStreamToAnthropic(upstream, { ...base, stream: false });
    const body = (await new Response(result.response.body).json()) as Record<string, unknown>;
    expect(body.type).toBe('message');
    expect(body.content).toEqual([{ type: 'text', text: '整包' }]);
    expect(body.stop_reason).toBe('end_turn');
  });

  test('空响应体不抛，返回空流', async () => {
    const result = chatStreamToAnthropic(new Response(null), base);
    expect(result.response.status).toBe(200);
    await expect(new Response(result.response.body).text()).resolves.toBe('');
  });

  test('非流式下游 + 上游返回整包 chat JSON 也能折叠（不是 SSE）', async () => {
    const upstream = new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hi from chat' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    const result = chatStreamToAnthropic(upstream, { ...base, stream: false });
    const body = (await new Response(result.response.body).json()) as Record<string, unknown>;
    expect(body.type).toBe('message');
    expect(body.content).toEqual([{ type: 'text', text: 'hi from chat' }]);
    expect(body.usage).toEqual({ input_tokens: 6, output_tokens: 3 });
  });
});

describe('validateMessagesBody', () => {
  test('messages 非空数组是必须的', () => {
    expect(() => validateMessagesBody({ messages: [] })).toThrow();
    expect(() => validateMessagesBody({})).toThrow();
  });

  test('max_tokens 缺省时补 4096，非数字报错', () => {
    const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'hi' }] };
    validateMessagesBody(body);
    expect(body.max_tokens).toBe(4096);
    expect(() => validateMessagesBody({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 'x' })).toThrow();
  });
});

describe('其它', () => {
  test('anthropicId 带前缀且足够随机', () => {
    const a = anthropicId('msg');
    expect(a.startsWith('msg_')).toBe(true);
    expect(a).not.toBe(anthropicId('msg'));
  });

  test('anthropicErrorResponse 用 Anthropic 错误形状，status 映射 type', async () => {
    const { ApiError } = await import('../src/lib/errors');
    const res = anthropicErrorResponse(new ApiError(429, '太频繁了', 'rate_limit_error', 'rate_limited'));
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe('error');
    expect((body.error as Record<string, unknown>).type).toBe('rate_limit_error');
    expect((body.error as Record<string, unknown>).message).toBe('太频繁了');
  });
});
