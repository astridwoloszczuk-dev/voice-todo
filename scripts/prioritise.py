#!/usr/bin/env python3
"""Prioritise unprocessed todos via Claude, update Supabase, notify urgent tasks via ntfy."""

import json
import os
import re
from datetime import datetime, timezone

import anthropic
import requests
from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
NTFY_TOPIC = os.environ["NTFY_TOPIC"]

CATEGORIES = ["work", "personal", "health", "finance", "household", "social", "learning", "errands", "general"]


def main():
    # 1. Create clients
    supa = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    ai = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    # 2. Fetch unprocessed pending todos
    resp = supa.table("todos").select("*").eq("status", "pending").eq("processed", 0).execute()
    todos = resp.data or []

    if not todos:
        print("No unprocessed todos — nothing to prioritise.")
        return

    print(f"Prioritising {len(todos)} tasks...")

    # 3. Format for Claude
    todo_list = "\n".join([f'- id:{t["id"]} | {t["text"]}' for t in todos])

    # 4. Call Claude
    prompt = (
        f"Analyse these tasks and return a JSON array. "
        f"For each task assign: priority (1=urgent, 2=high, 3=medium, 4=low, 5=someday), "
        f"category (one of: {', '.join(CATEGORIES)}), "
        f"and notes (max 80 chars, practical tip or context).\n\n"
        f"Tasks:\n{todo_list}\n\n"
        f"Return ONLY a JSON array like:\n"
        f'[{{"id": "...", "priority": 2, "category": "work", "notes": "..."}}]\n'
        f"No markdown, no explanation."
    )

    message = ai.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1000,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = message.content[0].text.strip()

    # 5. Strip markdown code blocks if present
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)

    try:
        results = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"Failed to parse Claude response: {e}")
        print(f"Raw response: {raw}")
        return

    # 6. Update each todo in Supabase
    now = datetime.now(timezone.utc).isoformat()
    urgent_tasks = []
    updated = 0

    for item in results:
        todo_id = item.get("id")
        priority = item.get("priority")
        category = item.get("category", "general")
        notes = item.get("notes", "")[:80]  # Enforce 80 char limit

        if not todo_id:
            continue

        supa.table("todos").update({
            "priority": priority,
            "category": category,
            "notes": notes,
            "processed": 1,
            "updated_at": now,
        }).eq("id", todo_id).execute()
        updated += 1

        if priority == 1:
            # Find the original task text
            matching = [t for t in todos if str(t["id"]) == str(todo_id)]
            if matching:
                urgent_tasks.append(matching[0]["text"])

    print(f"Updated {updated} tasks.")

    # 7. Send ntfy for urgent tasks
    for task_text in urgent_tasks:
        requests.post(
            f"https://ntfy.sh/{NTFY_TOPIC}",
            data=task_text.encode("utf-8"),
            headers={
                "Title": "Urgent task!",
                "Priority": "high",
                "Tags": "rotating_light",
            },
            timeout=10,
        )
        print(f"Sent urgent notification for: {task_text[:60]}")

    print(f"Done. {updated} tasks prioritised, {len(urgent_tasks)} urgent notifications sent.")


if __name__ == "__main__":
    main()
