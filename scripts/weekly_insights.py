#!/usr/bin/env python3
"""Weekly insights: analyse task history and send honest report via ntfy."""

import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone

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

    # 2. Fetch ALL todos from last 4 weeks
    four_weeks_ago = (datetime.now(timezone.utc) - timedelta(weeks=4)).isoformat()
    resp = supa.table("todos").select("*").gte("created_at", four_weeks_ago).execute()
    todos = resp.data or []

    total = len(todos)
    print(f"Found {total} tasks from the last 4 weeks.")

    # 3. Handle sparse data
    if total < 10:
        message = (
            "Keep going! You've only logged a few tasks so far. "
            "The more you use the app, the better I can help you spot patterns and improve your productivity. "
            "Try adding tasks throughout your day — even small ones count!"
        )
        requests.post(
            f"https://ntfy.sh/{NTFY_TOPIC}",
            data=message.encode("utf-8"),
            headers={
                "Title": "Weekly Insight",
                "Tags": "bar_chart",
            },
            timeout=10,
        )
        print("Sent encouragement message (too few tasks for full analysis).")
        return

    # 4. Build analysis data
    done = [t for t in todos if t["status"] == "done"]
    pending = [t for t in todos if t["status"] == "pending"]
    deleted = [t for t in todos if t["status"] == "deleted"]

    completion_rate = len(done) / total * 100 if total else 0

    # Speed by category (days from created to completed)
    category_times = defaultdict(list)
    for t in done:
        if t.get("completed_at") and t.get("created_at"):
            try:
                created = datetime.fromisoformat(t["created_at"].replace("Z", "+00:00"))
                completed = datetime.fromisoformat(t["completed_at"].replace("Z", "+00:00"))
                delta_days = (completed - created).total_seconds() / 86400
                cat = t.get("category") or "general"
                category_times[cat].append(delta_days)
            except Exception:
                pass

    speed_lines = []
    for cat, times in sorted(category_times.items()):
        avg = sum(times) / len(times)
        speed_lines.append(f"  {cat}: avg {avg:.1f} days to complete ({len(times)} tasks)")
    speed_text = "\n".join(speed_lines) if speed_lines else "  No completed tasks with timing data."

    # Priority accuracy: tasks marked urgent that took a long time
    urgent_done = [t for t in done if t.get("priority") == 1]
    slow_urgent = []
    for t in urgent_done:
        if t.get("completed_at") and t.get("created_at"):
            try:
                created = datetime.fromisoformat(t["created_at"].replace("Z", "+00:00"))
                completed = datetime.fromisoformat(t["completed_at"].replace("Z", "+00:00"))
                if (completed - created).days > 2:
                    slow_urgent.append(t["text"][:60])
            except Exception:
                pass

    analysis_text = (
        f"Task data for the last 4 weeks:\n"
        f"- Total tasks: {total}\n"
        f"- Completed: {len(done)} ({completion_rate:.0f}%)\n"
        f"- Still pending: {len(pending)}\n"
        f"- Deleted without completing: {len(deleted)}\n\n"
        f"Completion speed by category:\n{speed_text}\n\n"
        f"Urgent tasks that took more than 2 days: {len(slow_urgent)}\n"
        + ("\n".join(f"  - {t}" for t in slow_urgent[:5]) if slow_urgent else "  None")
    )

    # 5. Call Claude for honest insights
    message = ai.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=400,
        messages=[
            {
                "role": "user",
                "content": (
                    f"Here is a summary of my task management data:\n\n{analysis_text}\n\n"
                    "Write an honest, specific weekly insight report (max 200 words). Include:\n"
                    "1. One concrete observation about my completion patterns\n"
                    "2. One thing I seem to avoid or struggle with (based on pending/deleted tasks)\n"
                    "3. One actionable suggestion for next week\n"
                    "Be direct and specific — not generic motivational fluff."
                ),
            }
        ],
    )
    insight_text = message.content[0].text.strip()

    # 6. Send via ntfy (do NOT save to digests table)
    requests.post(
        f"https://ntfy.sh/{NTFY_TOPIC}",
        data=insight_text.encode("utf-8"),
        headers={
            "Title": "Weekly Insight",
            "Tags": "bar_chart",
        },
        timeout=10,
    )
    print("Sent weekly insight via ntfy.")
    print("Done.")


if __name__ == "__main__":
    main()
