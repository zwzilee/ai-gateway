-- 渠道协议能力（空格分隔）：responses = 上游原生支持 /v1/responses，chat = 只有 /v1/chat/completions。
-- 只在新增列上回填默认值，不改动已有渠道的任何行为：空串即「只有 chat」，/v1/responses
-- 请求会在网关内翻译成 chat 协议再翻译回去（见 src/lib/responses.ts）。
ALTER TABLE channels ADD COLUMN capabilities TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_channels_capabilities ON channels(capabilities);
