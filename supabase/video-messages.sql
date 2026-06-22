-- Відеоповідомлення зберігаються в тому ж bucket 'chat-media'
-- що й голосові (папка video/ замість voice/).
-- Якщо bucket вже існує — нічого робити не треба.
-- Якщо ні — виконай це:

-- 1. Створити bucket (якщо ще не існує)
-- INSERT INTO storage.buckets (id, name, public)
-- VALUES ('chat-media', 'chat-media', true)
-- ON CONFLICT DO NOTHING;

-- 2. Політика: дозволити аутентифікованим користувачам завантажувати відео
-- (якщо є Row Level Security на bucket)
-- CREATE POLICY "Allow upload video" ON storage.objects
--   FOR INSERT TO authenticated
--   WITH CHECK (bucket_id = 'chat-media' AND name LIKE 'video/%');

-- CREATE POLICY "Allow read video" ON storage.objects
--   FOR SELECT TO anon, authenticated
--   USING (bucket_id = 'chat-media' AND name LIKE 'video/%');

-- Нічого більше не потрібно: поле type в таблиці messages вже є TEXT,
-- тому тип 'video' зберігається автоматично.
