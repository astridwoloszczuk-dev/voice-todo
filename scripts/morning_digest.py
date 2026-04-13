#!/usr/bin/env python3
"""Morning digest: prioritise any unprocessed tasks, then summarise all pending todos via Claude, save to Supabase, notify via ntfy."""

import os
import json
from datetime import datetime, timezone

import anthropic
import requests
from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
NTFY_TOPIC = os.environ["NTFY_TOPIC"]


def prioritise_unprocessed(supa, ai):
    """Prioritise any tasks added since the last noon run."""
    resp = supa.table("todos").select("*").eq("status", "pending").eq("processed", 0).execute()
    unprocessed = resp.data or []

    if not unprocessed:
        print("No unprocessed tasks — skipping prioritisation step.")
        return

    print(f"Prioritising {len(unprocessed)} new task(s) before digest...")

    tasks_json = json.dumps([{"id": t["id"], "text": t["text"]} for t in unprocessed], indent=2)

    message = ai.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": (
                f"Analyse these tasks. Return a JSON array with fields: "
                f"id, priority (1=urgent, 2=high, 3=medium, 4=low, 5=someday), "
                f"category (work/personal/health/finance/household/social/learning/errands/general), "
                f"notes (max 80 chars, practical comment).\n\n"
                f"Tasks:\n{tasks_json}\n\nReturn ONLY valid JSON, no other text."
            )
        }]
    )

    text = message.content[0].text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    updates = json.loads(text.strip())

    now = datetime.now(timezone.utc).isoformat()
    for u in updates:
        supa.table("todos").update({
            "priority": u.get("priority", 3),
            "category": u.get("category", "general"),
            "notes": u.get("notes", ""),
            "processed": 1,
            "updated_at": now
        }).eq("id", u["id"]).execute()

        # Notify immediately for urgent tasks
        if u.get("priority") == 1:
            requests.post(
                f"https://ntfy.sh/{NTFY_TOPIC}",
                data=u.get("notes", u["id"]).encode("utf-8"),
                headers={"Title": "Urgent task flagged", "Tags": "rotating_light", "Priority": "high"},
                timeout=10,
            )

    print(f"Prioritised {len(updates)} task(s).")


def send_digest(supa, ai):
    """Generate and send the morning digest from all pending tasks."""
    resp = supa.table("todos").select("*").eq("status", "pending").execute()
    todos = resp.data or []

    if not todos:
        print("No pending todos — nothing to digest.")
        return

    # Sort: priority (nulls last), then created_at
    todos.sort(key=lambda t: (t["priority"] or 99, t["created_at"]))

    lines = []
    for t in todos:
        pri = f"P{t['priority']}" if t.get("priority") else "unranked"
        cat = t.get("category") or "general"
        lines.append(f"- [{pri}] [{cat}] {t['text']}")
    todo_text = "\n".join(lines)

    print(f"Generating digest for {len(todos)} task(s)...")

    message = ai.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=300,
        messages=[{
            "role": "user",
            "content": (
                f"Here are my pending tasks:\n\n{todo_text}\n\n"
                "Write a concise morning digest (max 150 words). Include:\n"
                "1. What needs urgent attention today\n"
                "2. What can wait\n"
                "3. One practical tip to make progress\n"
                "Be direct and actionable. No fluff."
            )
        }]
    )
    digest_text = message.content[0].text.strip()

    now = datetime.now(timezone.utc).isoformat()
    supa.table("digests").insert({"content": digest_text, "created_at": now}).execute()

    requests.post(
        f"https://ntfy.sh/{NTFY_TOPIC}",
        data=digest_text.encode("utf-8"),
        headers={"Title": "Morning Digest", "Tags": "calendar"},
        timeout=10,
    )
    print("Digest sent.")


def main():
    supa = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    ai = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    prioritise_unprocessed(supa, ai)  # Step 1: prioritise anything added overnight
    send_digest(supa, ai)             # Step 2: generate and send digest
    print("Done.")


if __name__ == "__main__":
    main()
