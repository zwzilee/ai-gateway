import { describe, expect, test } from 'bun:test';
import { responsesStreamToChat, responsesToChat } from '../src/lib/responses';
import { anthropicStreamToChat } from '../src/lib/anthropic';

/** 把若干 SSE 文本块拼成一个 Response（模拟上游流式） */
function sseResponse(frames: string[], delayMs = 0): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      for (const frame of frames) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        c.enqueue(encoder.encode(frame));
      }
      c.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
  });
}

/** 读出下游 SSE 的全部 data 负载（去掉 [DONE]） */
async function readChatStream(response: Response): Promise<Record<string, any>[]> {
  const text = await response.text();
  const out: Record<string, any>[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    out.push(JSON.parse(payload) as Record<string, any>);
  }
  return out;
}

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('responses → chat', () => {
  test('a whole Responses object becomes a chat.completion', () => {
    const chat = responsesToChat(
      {
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: '想一想' }] },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '你好' }],
          },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'get_weather',
            arguments: '{"city":"上海"}',
          },
        ],
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
      'gpt-6.1-sol',
    );
    expect(chat.object).toBe('chat.completion');
    expect(chat.model).toBe('gpt-6.1-sol');
    const choice = (chat.choices as Record<string, any>[])[0] as Record<string, any>;
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.content).toBe('你好');
    expect(choice.message.reasoning_content).toBe('想一想');
    expect(choice.message.tool_calls[0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"上海"}' },
    });
  });

  test('an incomplete response maps to a length stop', () => {
    const chat = responsesToChat(
      { id: 'resp_2', status: 'incomplete', output: [] },
      'm',
    );
    expect(((chat.choices as Record<string, any>[])[0] as Record<string, any>).finish_reason).toBe(
      'length',
    );
  });

  test('a streamed response is replayed as chat chunks', async () => {
    const upstream = sseResponse([
      frame('response.created', {
        response: { id: 'resp_3', status: 'in_progress', model: 'm' },
      }),
      frame('response.output_text.delta', { type: 'response.output_text.delta', delta: '你' }),
      frame('response.output_text.delta', { type: 'response.output_text.delta', delta: '好' }),
      frame('response.completed', {
        response: {
          id: 'resp_3',
          status: 'completed',
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        },
      }),
    ]);
    const result = responsesStreamToChat(upstream, { model: 'm', stream: true, idleMs: 5000 });
    const chunks = await readChatStream(result.response);
    const text = chunks.map((c) => (c.choices as Record<string, any>[])[0]?.delta?.content ?? '').join('');
    expect(text).toBe('你好');
    const last = chunks[chunks.length - 1] as Record<string, any>;
    expect((last.choices as Record<string, any>[])[0]?.finish_reason).toBe('stop');
    expect(last.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    const settled = await result.usage;
    expect(settled.usage?.promptTokens).toBe(5);
  });

  test('function calls keep their id, name and arguments when folded', async () => {
    const upstream = sseResponse([
      frame('response.output_item.added', {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'search' },
        output_index: 0,
      }),
      frame('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 0,
        delta: '{"q":',
      }),
      frame('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 0,
        delta: '"hi"}',
      }),
      frame('response.completed', { response: { id: 'resp_4', status: 'completed' } }),
    ]);
    const result = responsesStreamToChat(upstream, { model: 'm', stream: false, idleMs: 5000 });
    const body = (await result.response.json()) as Record<string, any>;
    const message = (body.choices as Record<string, any>[])[0]?.message as Record<string, any>;
    expect(message.content).toBeNull();
    expect(message.tool_calls[0]).toEqual({
      id: 'call_9',
      type: 'function',
      function: { name: 'search', arguments: '{"q":"hi"}' },
    });
    expect((body.choices as Record<string, any>[])[0]?.finish_reason).toBe('tool_calls');
  });

  test('a whole JSON body is accepted when the upstream ignores stream=true', async () => {
    const upstream = jsonResponse({
      id: 'resp_5',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '整包' }] }],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    });
    const result = responsesStreamToChat(upstream, { model: 'm', stream: true, idleMs: 5000 });
    const chunks = await readChatStream(result.response);
    const text = chunks.map((c) => (c.choices as Record<string, any>[])[0]?.delta?.content ?? '').join('');
    expect(text).toBe('整包');
    expect((await result.usage).usage?.completionTokens).toBe(1);
  });
});

describe('anthropic → chat', () => {
  test('a streamed message is replayed as chat chunks', async () => {
    const upstream = sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude","usage":{"input_tokens":9,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"嗨"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"呀"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    const result = anthropicStreamToChat(upstream, { model: 'm', stream: true, idleMs: 5000 });
    const chunks = await readChatStream(result.response);
    const text = chunks.map((c) => (c.choices as Record<string, any>[])[0]?.delta?.content ?? '').join('');
    expect(text).toBe('嗨呀');
    expect((chunks[chunks.length - 1] as Record<string, any>).usage).toEqual({
      prompt_tokens: 9,
      completion_tokens: 2,
      total_tokens: 11,
    });
  });

  test('tool_use blocks become chat tool calls with arguments', async () => {
    const upstream = sseResponse([
      'data: {"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":4,"output_tokens":0}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"1}"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    const result = anthropicStreamToChat(upstream, { model: 'm', stream: false, idleMs: 5000 });
    const body = (await result.response.json()) as Record<string, any>;
    const choice = (body.choices as Record<string, any>[])[0] as Record<string, any>;
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.tool_calls[0]).toEqual({
      id: 'toolu_1',
      type: 'function',
      function: { name: 'lookup', arguments: '{"a":1}' },
    });
  });

  test('a whole message body is folded when the upstream answers with JSON', async () => {
    const upstream = jsonResponse({
      id: 'msg_3',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: '先说一句' },
        { type: 'tool_use', id: 'toolu_2', name: 'calc', input: { x: 2 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 6, output_tokens: 5 },
    });
    const result = anthropicStreamToChat(upstream, { model: 'm', stream: true, idleMs: 5000 });
    const chunks = await readChatStream(result.response);
    const text = chunks.map((c) => (c.choices as Record<string, any>[])[0]?.delta?.content ?? '').join('');
    expect(text).toBe('先说一句');
    const toolFrames = chunks.flatMap((c) => (c.choices as Record<string, any>[])[0]?.delta?.tool_calls ?? []);
    expect(toolFrames[0]).toEqual({
      index: 0,
      id: 'toolu_2',
      type: 'function',
      function: { name: 'calc', arguments: '{"x":2}' },
    });
  });
});
