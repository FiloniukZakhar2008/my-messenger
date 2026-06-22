-- =============================================================
-- profile-fields.sql
-- Запусти у Supabase → SQL Editor
-- =============================================================

-- 1. Додаємо колонки (якщо ще не існують)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS bio text DEFAULT '',
  ADD COLUMN IF NOT EXISTS avatar_color text DEFAULT '';

-- 2. RLS-політики для оновлення профілю
--    (потрібні якщо Row Level Security увімкнено на таблиці users)

-- Дозволяємо SELECT усім автентифікованим (читати профілі)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'users' AND policyname = 'users_select_all'
  ) THEN
    EXECUTE 'CREATE POLICY users_select_all ON users FOR SELECT USING (true)';
  END IF;
END$$;

-- Дозволяємо UPDATE будь-якого рядка через service_role (сервер використовує anon key,
-- тому найпростіше — вимкнути RLS на таблиці users, або використати service_role key)
-- ВАРІАНТ А (рекомендовано): вимкнути RLS на таблиці users
ALTER TABLE users DISABLE ROW LEVEL SECURITY;

-- ВАРІАНТ Б (якщо хочеш залишити RLS): закоментуй рядок вище і розкоментуй нижче,
-- але тоді у server.js потрібно використовувати SUPABASE_SERVICE_KEY замість anon key:
-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY IF NOT EXISTS users_update_own ON users
--   FOR UPDATE USING (true) WITH CHECK (true);

-- 3. Перевірка: виводить колонки таблиці users
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'users'
ORDER BY ordinal_position;
