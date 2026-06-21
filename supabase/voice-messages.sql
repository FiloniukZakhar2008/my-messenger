-- Запусти цей скрипт у Supabase → SQL Editor

-- 1. Нові колонки для медіа-повідомлень
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS media_url text,
  ADD COLUMN IF NOT EXISTS duration real;

-- 2. Bucket для голосових (якщо ще не створений)
INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-media', 'chat-media', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 3. Політики Storage (якщо політика вже є — пропусти відповідний рядок)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Public read chat media'
  ) THEN
    CREATE POLICY "Public read chat media"
      ON storage.objects FOR SELECT
      USING (bucket_id = 'chat-media');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Server upload chat media'
  ) THEN
    CREATE POLICY "Server upload chat media"
      ON storage.objects FOR INSERT
      WITH CHECK (bucket_id = 'chat-media');
  END IF;
END $$;
