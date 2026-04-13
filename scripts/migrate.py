#!/usr/bin/env python3
"""Migrate existing todos from SQLite to Supabase."""

import os
import sqlite3
from datetime import timezone

from dotenv import load_dotenv
from supabase import create_client

# Load .env from the old Flask app directory
load_dotenv("C:/Users/astri/OneDrive/(00) CLAUDE CODE/voice-todo/.env")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
DB_PATH = "C:/Users/astri/OneDrive/(00) CLAUDE CODE/voice-todo/todos.db"


def main():
    supa = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM todos WHERE status != 'deleted'")
    rows = cursor.fetchall()
    conn.close()

    print(f"Found {len(rows)} tasks to migrate.")

    migrated = 0
    skipped = 0

    for row in rows:
        record = {
            "text": row["text"],
            "status": row["status"],
        }

        # Map optional fields if they exist in the SQLite schema
        for field in ["priority", "category", "notes", "due_date", "scheduled_time", "processed"]:
            try:
                val = row[field]
                if val is not None:
                    record[field] = val
            except IndexError:
                pass

        # Handle timestamps — skip if null
        for ts_field in ["created_at", "updated_at"]:
            try:
                val = row[ts_field]
                if val:
                    record[ts_field] = val
            except IndexError:
                pass

        for ts_field in ["completed_at", "deleted_at"]:
            try:
                val = row[ts_field]
                if val:
                    record[ts_field] = val
            except IndexError:
                pass

        try:
            result = supa.table("todos").insert(record).execute()
            print(f"  Migrated: {row['text'][:60]}")
            migrated += 1
        except Exception as e:
            print(f"  Skipped (error): {row['text'][:60]} — {e}")
            skipped += 1

    print(f"\nDone. Migrated: {migrated}, Skipped: {skipped}")


if __name__ == "__main__":
    main()
