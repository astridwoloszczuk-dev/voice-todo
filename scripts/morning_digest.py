#!/usr/bin/env python3
"""Morning digest: summarise pending todos via Claude, save to Supabase, notify via ntfy."""

import os
import sys
from datetime import datetime, timezone

import anthropic
import requests
from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
NTFY_TOPIC = os.environ["NTFY_TOPIC"]


def main():
    # 1. Create clients
    supa = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    ai = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    # 2. Fetch all pending todos
    resp = supa.table("todos").select("*").eq("status", "pending").execute()
    todos = resp.data or []

    if not todos:
        print("No pending todos — nothing to digest.")
        return

    # 3. Format todos as text
    lines = []
    for t in todos:
        pri = f"P{t['priority']}" if t.get("priority") else "unranked"
        cat = t.get("category") or "general"
        lines.append(f"- [{pri}] [{cat}] {t['text']}")
    todo_text = "\n".join(lines)

    print(f"Generating digest for {len(todos)} tasks...")

    # 4. Call Claude for digest
    message = ai.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=300,
        messages=[
            {
                "role": "user",
                "content": (
                    f"Here are my pending tasks:\n\n{todo_text}\n\n"
                    "Write a concise morning digest (max 150 words). Include:\n"
                    "1. What needs urgent attention today\n"
                    "2. What can wait\n"
                    "3. One practical tip to make progress\n"
                    "Be direct and actionable. No fluff."
                ),
            }
        ],
    )
    digest_text = message.content[0].text.strip()

    # 5. Save digest to Supabase
    now = datetime.now(timezone.utc).isoformat()
    supa.table("digests").insert({"content": digest_text, "created_at": now}).execute()
    print("Saved digest to Supabase.")

    # 6. Send via ntfy
    requests.post(
        f"https://ntfy.sh/{NTFY_TOPIC}",
        data=digest_text.encode("utf-8"),
        headers={
            "Title": "Morning Digest",
            "Tags": "calendar",
        },
        timeout=10,
    )
    print("Sent ntfy notification.")
    print("Done.")


if __name__ == "__main__":
    main()
