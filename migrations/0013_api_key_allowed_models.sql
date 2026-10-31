-- NULL：允许全部模型（兼容已有密钥）；JSON 数组：仅允许精确匹配的模型 ID。
-- [] 明确表示禁止所有模型。仅增列，不修改已有密钥、额度或用量。
ALTER TABLE api_keys ADD COLUMN allowed_models TEXT DEFAULT NULL
  CHECK (allowed_models IS NULL OR CASE WHEN json_valid(allowed_models)
    THEN json_type(allowed_models) = 'array' ELSE 0 END);
