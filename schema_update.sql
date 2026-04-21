-- Run this in your Supabase SQL editor (voice-todo project)

ALTER TABLE todos ADD COLUMN IF NOT EXISTS owner text;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS added_by_name text;

-- Default existing todos to Astrid
UPDATE todos SET owner = 'Astrid' WHERE owner IS NULL AND status != 'deleted';

-- Enable real-time if not already on
ALTER publication supabase_realtime ADD TABLE todos;
