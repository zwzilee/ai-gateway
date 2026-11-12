/**
 * Responses 协议适配层的单元测试（/v1/responses）。
 *
 * 只测纯逻辑与「用假上游喂流」—— 不碰网络、不碰 D1。覆盖三块：
 *   1. 请求翻译：Responses → chat/completions（含工具、多模态、role 归一）
 *   2. 非流式反向转换：chat.completion → Response 对象
 *   3. 流式状态机：chat SSE → Responses 事件序列（含工具调用与截断）
 */
import { describe, expect, test } from 'bun:test';
import {
  buildChatRequest,
  chatStreamToResponses,
  chatToResponse,
  extractResponsesUsage,
  responsesId,
  toResponseUsage,
  validateResponsesBody,
} from '../src/lib/responses';

const CHAT = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'upstream-model',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: '你好呀' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
};

describe('buildChatRequest', () => {
  test('instructions 变成 system，字符串 input 变成 user', () => {
    const chat = buildChatRequest(
      { model: 'gpt-4o', instructions: '你是香香', input: '在吗' },
      'upstream-model',
      false,
    );
    expect(chat.model).toBe('upstream-model');
    expect(chat.messages).toEqual([
      { role: 'system', content: '你是香香' },
      { role: 'user', content: '在吗' },
    ]);
    expect(chat.stream).toBeUndefined();
  });

  test('developer 角色并进 system，消息内容块压成字符串', () => {
    const chat = buildChatRequest(
      {
        model: 'm',
        input: [
          { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '规矩' }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '问题' }] },
        ],
      },
      'u',
      false,
    );
    expect(chat.messages).toEqual([
      { role: 'system', content: '规矩' },
      { role: 'user', content: '问题' },
    ]);
  });

  test('含图片时保留内容数组，detail 只放三档合法值', () => {
    const chat = buildChatRequest(
      {
        model: 'm',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: '这是什么' },
              { type: 'input_image', image_url: 'https://x/y.png', detail: 'high' },
            ],
          },
        ],
      },
      'u',
      false,
    );
    expect(chat.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是什么' },
          { type: 'image_url', image_url: { url: 'https://x/y.png', detail: 'high' } },
        ],
      },
    ]);
  });

  test('同一轮的多个 function_call 并进同一条 assistant 消息', () => {
    const chat = buildChatRequest(
      {
        model: 'm',
        input: [
          { role: 'user', content: '查天气和汇率' },
          { type: 'function_call', call_id: 'c1', name: 'weather', arguments: '{"city":"深圳"}' },
          { type: 'function_call', call_id: 'c2', name: 'fx', arguments: '{}' },
          { type: 'function_call_output', call_id: 'c1', output: '晴' },
        ],
      },
      'u',
      false,
    );
    expect(chat.messages).toEqual([
      { role: 'user', content: '查天气和汇率' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"深圳"}' } },
          { id: 'c2', type: 'function', function: { name: 'fx', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '晴' },
    ]);
  });

  test('function 工具转换；平台内建工具被丢弃（chat 协议没有对应物）', () => {
    const chat = buildChatRequest(
      {
        model: 'm',
        input: 'x',
        tools: [
          { type: 'function', name: 'calc', description: '算术', parameters: { type: 'object' }, strict: true },
          { type: 'web_search' },
        ],
        tool_choice: { type: 'function', name: 'calc' },
      },
      'u',
      false,
    );
    expect(chat.tools).toEqual([
      { type: 'function', function: { name: 'calc', description: '算术', parameters: { type: 'object' }, strict: true } },
    ]);
    expect(chat.tool_choice).toEqual({ type: 'function', function: { name: 'calc' } });
  });

  test('max_output_tokens 优先于 max_tokens；text.format 映射 response_format', () => {
    const chat = buildChatRequest(
      {
        model: 'm',
        input: 'x',
        max_output_tokens: 256,
        max_tokens: 999,
        temperature: 0,
        text: { format: { type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true } },
      },
      'u',
      true,
    );
    expect(chat.max_tokens).toBe(256);
    expect(chat.temperature).toBe(0);
    expect(chat.stream).toBe(true);
    expect(chat.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'out', schema: { type: 'object' }, strict: true },
    });
  });

  test('空 messages 补一条空 user（否则多数上游 400）', () => {
    const chat = buildChatRequest({ model: 'm', input: [] }, 'u', false);
    expect(chat.messages).toEqual([{ role: 'user', content: '' }]);
  });
});

describe('chatToResponse', () => {
  test('文本回答：一条 message 项 + usage 对齐', () => {
    const res = chatToResponse(CHAT, { model: 'm', input: 'hi' }, 'downstream-name', 'resp_1');
    expect(res.object).toBe('response');
    expect(res.id).toBe('resp_1');
    expect(res.model).toBe('downstream-name');
    expect(res.status).toBe('completed');
    expect(res.output).toHaveLength(1);
    const msg = (res.output as any[])[0];
    expect(msg.type).toBe('message');
    expect(msg.role).toBe('assistant');
    expect(msg.content[0].type).toBe('output_text');
    expect(msg.content[0].text).toBe('你好呀');
    expect(res.usage).toEqual({
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    });
  });

  test('reasoning_content 单独出一个 reasoning 项，排在正文前', () => {
    const res = chatToResponse(
      {
        ...CHAT,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', reasoning_content: '先想想', content: '结论' },
            finish_reason: 'stop',
          },
        ],
      },
      { model: 'm', input: 'hi' },
      'm',
      'resp_2',
    );
    const out = res.output as any[];
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe('reasoning');
    expect(out[0].summary[0].text).toBe('先想想');
    expect(out[1].content[0].text).toBe('结论');
  });

  test('工具调用转成 function_call 项；finish_reason=length 标 incomplete', () => {
    const res = chatToResponse(
      {
        ...CHAT,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'calc', arguments: '{"a":1}' } }],
            },
            finish_reason: 'length',
          },
        ],
      },
      { model: 'm', input: 'hi' },
      'm',
      'resp_3',
    );
    expect(res.status).toBe('incomplete');
    expect(res.incomplete_details).toEqual({ reason: 'max_output_tokens' });
    const call = (res.output as any[])[0];
    expect(call.type).toBe('function_call');
    expect(call.call_id).toBe('call_1');
    expect(call.name).toBe('calc');
    expect(call.arguments).toBe('{"a":1}');
  });

  test('缺 usage 时退回估算，并标记在 details 里不影响结构', () => {
    const res = chatToResponse(
      { choices: [{ index: 0, message: { content: 'abc' }, finish_reason: 'stop' }] },
      { model: 'm', input: 'hi' },
      'm',
      'resp_4',
    );
    const usage = res.usage as any;
    expect(usage.input_tokens).toBeGreaterThanOrEqual(0);
    expect(usage.output_tokens).toBeGreaterThan(0);
    expect(usage.total_tokens).toBe(usage.input_tokens + usage.output_tokens);
  });

  test('refusal 走 refusal 内容块', () => {
    const res = chatToResponse(
      { choices: [{ index: 0, message: { refusal: '不聊这个' }, finish_reason: 'stop' }] },
      { model: 'm', input: 'hi' },
      'm',
      'resp_5',
    );
    const msg = (res.output as any[])[0];
    expect(msg.content[0].type).toBe('refusal');
    expect(msg.content[0].refusal).toBe('不聊这个');
  });
});

describe('usage 双向映射', () => {
  test('原生 Responses usage 读出 cached_tokens', () => {
    const usage = extractResponsesUsage({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 20,
      total_tokens: 120,
    });
    expect(usage).not.toBeNull();
    expect(usage!.promptTokens).toBe(100);
    expect(usage!.completionTokens).toBe(20);
    expect(usage!.cachedTokens).toBe(40);
    expect(usage!.totalTokens).toBe(120);
  });

  test('空 usage 返回 null（交给估算兜底）', () => {
    expect(extractResponsesUsage({ input_tokens: 0, output_tokens: 0 })).toBeNull();
    expect(extractResponsesUsage(null)).toBeNull();
  });

  test('TokenUsage → Responses usage 的字段齐全', () => {
    const out = toResponseUsage({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cachedTokens: 2,
      estimated: false,
    });
    expect(out).toEqual({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 2, cache_write_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    });
  });
});

describe('validateResponsesBody', () => {
  test('input 与 previous_response_id 都缺时报 input', () => {
    expect(() => validateResponsesBody({ model: 'm' })).toThrow();
    try {
      validateResponsesBody({ model: 'm' });
    } catch (error: any) {
      expect(error.status).toBe(400);
      expect(error.param).toBe('input');
    }
  });

  test('有 previous_response_id 时不必给 input', () => {
    expect(() => validateResponsesBody({ model: 'm', previous_response_id: 'resp_x' })).not.toThrow();
  });

  test('input 项数上限 10000', () => {
    const ok = Array.from({ length: 10_000 }, () => 'x');
    expect(() => validateResponsesBody({ model: 'm', input: ok })).not.toThrow();
    const tooMany = Array.from({ length: 10_001 }, () => 'x');
    expect(() => validateResponsesBody({ model: 'm', input: tooMany })).toThrow();
  });
});

describe('responsesId', () => {
  test('前缀正确、长度稳定、每次不同', () => {
    const a = responsesId('resp');
    const b = responsesId('resp');
    expect(a.startsWith('resp_')).toBe(true);
    expect(a).toHaveLength(5 + 22);
    expect(a).not.toBe(b);
    expect(/^[A-Za-z0-9_-]+$/.test(a.slice(5))).toBe(true);
  });
});

// ---------------------------------------------------------------- 流式

/** 把一段 chat SSE 文本包成假上游 Response */
function sse(chunks: unknown[]): Response {
  const body = chunks
    .map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`)
    .join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function collect(res: Response): Promise<Array<{ event: string | null; data: any }>> {
  const text = await res.text();
  const out: Array<{ event: string | null; data: any }> = [];
  for (const frame of text.split('\n\n')) {
    const lines = frame.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    const evLine = lines.find((l) => l.startsWith('event:'));
    const dataLine = lines.find((l) => l.startsWith('data:'));
    if (!dataLine) continue;
    out.push({
      event: evLine ? evLine.slice(6).trim() : null,
      data: JSON.parse(dataLine.slice(5).trim()),
    });
  }
  return out;
}

const TEXT_CHUNKS = [
  { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '你' } }] },
  { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '好' } }] },
  {
    id: 'c',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
  },
  '[DONE]',
];

describe('chatStreamToResponses / 流式', () => {
  test('事件顺序与 sequence_number 单调', async () => {
    const { response, usage } = chatStreamToResponses(sse(TEXT_CHUNKS), {
      request: { model: 'm', input: 'hi' },
      model: 'downstream',
      responseId: 'resp_s1',
      stream: true,
      idleMs: 5000,
    });
    const events = await collect(response);
    const types = events.map((e) => e.data.type);
    expect(types[0]).toBe('response.created');
    expect(types[1]).toBe('response.in_progress');
    expect(types.includes('response.output_text.delta')).toBe(true);
    expect(types[types.length - 1]).toBe('response.completed');
    // event: 行与 data.type 一致
    for (const e of events) expect(e.event).toBe(e.data.type);
    // sequence_number 从 0 连续递增
    events.forEach((e, i) => expect(e.data.sequence_number).toBe(i));

    const done = events[events.length - 1]!.data.response;
    expect(done.status).toBe('completed');
    expect(done.output).toHaveLength(1);
    expect(done.output[0].content[0].text).toBe('你好');
    expect(done.usage.input_tokens).toBe(7);
    expect(done.usage.output_tokens).toBe(2);

    const settled = await usage;
    expect(settled.error).toBeNull();
    expect(settled.usage.promptTokens).toBe(7);
    expect(settled.usage.completionTokens).toBe(2);
  });

  test('流里的 delta 拼接完整，output_text.done 带上全文', async () => {
    const { response } = chatStreamToResponses(sse(TEXT_CHUNKS), {
      request: { model: 'm', input: 'hi' },
      model: 'm',
      responseId: 'resp_s2',
      stream: true,
      idleMs: 5000,
    });
    const events = await collect(response);
    const deltas = events.filter((e) => e.data.type === 'response.output_text.delta');
    expect(deltas.map((d) => d.data.delta).join('')).toBe('你好');
    const textDone = events.find((e) => e.data.type === 'response.output_text.done');
    expect(textDone!.data.text).toBe('你好');
  });

  test('工具调用：先关正文，再发 arguments 增量与 function_call 项', async () => {
    const { response } = chatStreamToResponses(
      sse([
        { choices: [{ index: 0, delta: { role: 'assistant', content: '我查一下' } }] },
        {
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'calc', arguments: '{"a"' } }] } },
          ],
        },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]),
      { request: { model: 'm', input: 'hi' }, model: 'm', responseId: 'resp_s3', stream: true, idleMs: 5000 },
    );
    const events = await collect(response);
    const types = events.map((e) => e.data.type);
    const firstCallDelta = types.indexOf('response.function_call_arguments.delta');
    const textDoneIdx = types.indexOf('response.output_text.done');
    expect(textDoneIdx).toBeGreaterThan(-1);
    expect(firstCallDelta).toBeGreaterThan(textDoneIdx);

    const final = events[events.length - 1]!.data.response;
    const call = final.output.find((o: any) => o.type === 'function_call');
    expect(call.call_id).toBe('call_9');
    expect(call.name).toBe('calc');
    expect(call.arguments).toBe('{"a":1}');
    expect(final.status).toBe('completed');
  });

  test('finish_reason=length → response.incomplete', async () => {
    const { response } = chatStreamToResponses(
      sse([
        { choices: [{ index: 0, delta: { content: '写到一半' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 } },
        '[DONE]',
      ]),
      { request: { model: 'm', input: 'hi' }, model: 'm', responseId: 'resp_s4', stream: true, idleMs: 5000 },
    );
    const events = await collect(response);
    const last = events[events.length - 1]!;
    expect(last.data.type).toBe('response.incomplete');
    expect(last.data.response.status).toBe('incomplete');
    expect(last.data.response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });

  test('非流式下游：同一状态机折叠成整包 JSON', async () => {
    const { response, usage, payload } = chatStreamToResponses(sse(TEXT_CHUNKS), {
      request: { model: 'm', input: 'hi', max_output_tokens: 64 },
      model: 'downstream',
      responseId: 'resp_s5',
      stream: false,
      idleMs: 5000,
    });
    expect(response.headers.get('content-type')!.includes('application/json')).toBe(true);
    const body = JSON.parse(await response.text());
    expect(body.object).toBe('response');
    expect(body.id).toBe('resp_s5');
    expect(body.model).toBe('downstream');
    expect(body.max_output_tokens).toBe(64);
    expect(body.output[0].content[0].text).toBe('你好');
    const settled = await usage;
    expect(settled.error).toBeNull();
    expect(await payload).not.toBeNull();
  });

  test('上游空响应体不会抛，给出空流并标记错误', async () => {
    const { response, usage } = chatStreamToResponses(new Response(null), {
      request: { model: 'm', input: 'hi' },
      model: 'm',
      responseId: 'resp_s6',
      stream: true,
      idleMs: 1000,
    });
    const text = await response.text();
    expect(text).toBe('');
    const settled = await usage;
    expect(settled.error).not.toBeNull();
  });
});
