import { describe, expect, test } from 'bun:test';
import {
  channelProtocols,
  mentionsOtherEndpoint,
  normalizeCapabilities,
  protocolMismatch,
} from '../src/lib/protocols';

const channel = (capabilities: string) => ({ capabilities });

describe('channel capabilities', () => {
  test('empty means plain chat', () => {
    expect([...channelProtocols(channel(''))]).toEqual(['chat']);
  });

  test('known tokens are kept regardless of order', () => {
    const set = channelProtocols(channel('chat responses anthropic'));
    expect(set.has('chat')).toBe(true);
    expect(set.has('responses')).toBe(true);
    expect(set.has('anthropic')).toBe(true);
  });

  test('unknown tokens never widen the capability', () => {
    const set = channelProtocols(channel('woo'));
    expect([...set]).toEqual(['chat']);
  });

  test('the normalised string is stable and ordered', () => {
    expect(normalizeCapabilities('chat,responses')).toBe('responses chat');
    expect(normalizeCapabilities(['openai-chat', 'claude'])).toBe('anthropic chat');
    expect(normalizeCapabilities('  ')).toBe('');
    expect(normalizeCapabilities(undefined)).toBe('');
  });
});

describe('wrong protocol detection', () => {
  test('a provider hint about another endpoint counts', () => {
    const body =
      '{"error":{"message":"模型 gpt-6.1-sol 不支持 /v1/chat/completions 接口，请改用 /v1/responses（OpenAI Responses API）"}}';
    expect(mentionsOtherEndpoint(body)).toBe(true);
    expect(protocolMismatch(400, body)).toBe('要求改用 /v1/responses');
  });

  test('an ordinary failure is not a protocol mismatch', () => {
    expect(protocolMismatch(400, '{"error":{"message":"invalid api key"}}')).toBeNull();
  });

  test('server side status codes are never treated as a mismatch', () => {
    const body = 'please use /v1/responses';
    expect(protocolMismatch(500, body)).toBeNull();
    expect(protocolMismatch(429, body)).toBeNull();
  });
});
