-- Phase 6 update (9 Nov 2026): one model per AI task, all claude-haiku-5-5 by default;
-- the refusal-fallback model for models with no server-side fallback (Haiku 5.5);
-- Haiku 5.5 prices, including its long-context rate (5x above 100K prompt tokens).
-- Config only; values already set are never overwritten.

insert into cms.cms_config (key, value, note) values
  ('ai_model_generate', '"claude-haiku-5-5"', 'Model for Generate similar / Fill a question type'),
  ('ai_model_tag', '"claude-haiku-5-5"', 'Model for tagging (and the default for the Model check)'),
  ('ai_model_extract', '"claude-haiku-5-5"', 'Model for extracting questions from a source (Phase 7)'),
  ('ai_fallback_model', '"claude-sonnet-5-5"', 'Retried once when a model with no server-side refusal fallback (Haiku 5.5) declines (each attempt is logged with its model and cost)')
on conflict (key) do nothing;

-- Haiku 5.5: $0.10 / $0.50 per million tokens up to 100K prompt tokens, $0.50 / $2.50 above.
-- Cache write 1.25x and cache read 0.1x of input (the published multipliers; Haiku's exact cache-read rate is a guess until checked on the pricing page).
update cms.cms_config
   set value = value || '{"claude-haiku-5-5": {"input": 0.1, "output": 0.5, "cache_write": 0.125, "cache_read": 0.01,
                         "long": {"above": 100000, "input": 0.5, "output": 2.5, "cache_write": 0.625, "cache_read": 0.05}}}'::jsonb
 where key = 'ai_prices' and not (value ? 'claude-haiku-5-5');

-- The single ai_model key is replaced by the per-task keys; it goes only if it still holds the 0013 default.
delete from cms.cms_config where key = 'ai_model' and value = '"claude-sonnet-5-5"'::jsonb;

update cms.cms_config set note = 'Effort for every AI task (Haiku 5.5 and Opus 5.5 default to medium; Sonnet 5.5 to high)'
 where key = 'ai_effort' and note = 'Effort for generation (the API default)';
