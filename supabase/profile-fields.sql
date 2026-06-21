-- Запусти цей скрипт у Supabase → SQL Editor
-- Додає публічний підпис (bio) і колір аватарки, які бачать інші користувачі

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS bio text,
  ADD COLUMN IF NOT EXISTS avatar_color text;
