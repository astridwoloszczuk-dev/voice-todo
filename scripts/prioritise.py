#!/usr/bin/env python3
"""Prioritise unprocessed todos via Claude, generate per-person blurbs, update Supabase."""

import json
import os
import re
import time
from datetime import datetime, timezone

import anthropic
import requests
from supabase import create_client

SUPABASE_URL        = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
ANTHROPIC_API_KEY   = os.environ["ANTHROPIC_API_KEY"]
NTFY_TOPIC          = os.environ.get("NTFY_TOPIC", "")

MEMBERS  = ["Astrid", "Niko", "Max", "Alex", "Vicky", "Astrid & Niko"]
CHILDREN = {"Max", "Alex", "Vicky"}
SHARED_LABEL = "Astrid & Niko"
SHARED_MEMBERS = {"Astrid", "Niko"}
CHILD_AGES = {"Max": 15, "Alex": 13, "Vicky": 11}

CATEGORIES = ["work", "personal", "health", "finance", "household", "social", "learning", "errands", "general"]

PRIORITY_RULES = """
Priority levels (use exactly these words):
- high     → genuine urgency, real deadline, health/safety, or meaningful consequence if missed
- medium   → should happen this week, no immediate crisis
- low      → nice to do, no real deadline
- someday  → aspirational, no timeline

Important: for tasks owned by a child, apply extra scepticism to urgency claims.
Children tend to label everything "URGENT". Buying ice cream, wanting a new game,
needing snacks — these are low or someday regardless of the language used.
Health appointments, school deadlines, and genuine responsibilities are still high.
"""

PRIORITY_ORDER = {"high": 0, "medium": 1, "low": 2, "someday": 3}


# ── Step 1: Prioritise unprocessed todos ─────────────────────────────────────

def prioritise(supa, ai):
    resp = (
        supa.table("todos")
        .select("id, text, owner, added_by_name")
        .eq("status", "pending")
        .eq("processed", 0)
        .execute()
    )
    todos = resp.data or []

    if not todos:
        print("No unprocessed todos.")
        return []

    print(f"Prioritising {len(todos)} todos...")

    todo_lines = []
    for t in todos:
        owner = t.get("owner") or t.get("added_by_name") or "unknown"
        role  = "child" if owner in CHILDREN else "parent"
        todo_lines.append(f'- id:{t["id"]} | owner:{owner} ({role}) | {t["text"]}')

    prompt = (
        f"{PRIORITY_RULES}\n\n"
        f"Categories (pick one): {', '.join(CATEGORIES)}\n\n"
        f"Analyse these tasks and return a JSON array.\n"
        f"For each task include:\n"
        f"  id (integer)\n"
        f"  priority (one of: high, medium, low, someday)\n"
        f"  category (one of the categories above)\n"
        f"  reasoning (max 80 chars)\n\n"
        f"Tasks:\n" + "\n".join(todo_lines) + "\n\n"
        f"Return ONLY a JSON array, no markdown.\n"
        f'Example: [{{"id": 3, "priority": "medium", "category": "health", "reasoning": "Routine, no acute risk."}}]'
    )

    for attempt in range(3):
        try:
            message = ai.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=1500,
                messages=[{"role": "user", "content": prompt}],
            )
            break
        except Exception as e:
            print(f"API attempt {attempt + 1} failed: {e}")
            if attempt == 2:
                raise
            time.sleep(10)

    raw = message.content[0].text.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)

    try:
        results = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"Failed to parse Claude response: {e}\nRaw: {raw}")
        return []

    now = datetime.now(timezone.utc).isoformat()
    urgent = []
    updated = 0

    for item in results:
        todo_id  = item.get("id")
        priority = item.get("priority", "medium")
        category = item.get("category", "general")
        reasoning = item.get("reasoning", "")[:80]
        if not todo_id:
            continue

        supa.table("todos").update({
            "priority": priority,
            "priority_reasoning": reasoning,
            "category": category,
            "processed": 1,
            "updated_at": now,
        }).eq("id", todo_id).execute()
        updated += 1

        if priority == "high":
            matching = [t for t in todos if str(t["id"]) == str(todo_id)]
            if matching:
                urgent.append(matching[0]["text"])

    print(f"Prioritised {updated} todos.")

    # ntfy for urgent tasks
    if NTFY_TOPIC:
        for task_text in urgent:
            try:
                requests.post(
                    f"https://ntfy.sh/{NTFY_TOPIC}",
                    data=task_text.encode("utf-8"),
                    headers={"Title": "High priority task", "Priority": "high", "Tags": "rotating_light"},
                    timeout=10,
                )
            except Exception as e:
                print(f"ntfy failed: {e}")

    return results


# ── Step 2: Generate per-person blurbs ───────────────────────────────────────

def generate_blurbs(supa, ai):
    resp = (
        supa.table("todos")
        .select("id, text, owner, priority, priority_reasoning, category")
        .eq("status", "pending")
        .in_("owner", MEMBERS)
        .execute()
    )
    all_todos = resp.data or []

    now = datetime.now(timezone.utc).isoformat()

    for person in MEMBERS:
        if person == SHARED_LABEL:
            continue  # no standalone blurb for the shared tab
        todos = [t for t in all_todos if t.get("owner") == person or
                 (person in SHARED_MEMBERS and t.get("owner") == SHARED_LABEL)]
        todos.sort(key=lambda t: PRIORITY_ORDER.get(t.get("priority"), 99))

        if not todos:
            blurb = f"Nothing on your list right now — enjoy the breathing room!"
        else:
            is_child = person in CHILDREN
            age = CHILD_AGES.get(person, "")
            if is_child:
                tone = f"{person} is {age} years old. Be warm, friendly and brief — not preachy."
            else:
                tone = f"{person} is a parent. Be direct and concise — headline only, no pep talk."

            todo_lines = []
            for t in todos[:10]:  # cap at 10 for prompt size
                r = t.get("priority_reasoning") or ""
                todo_lines.append(f"  [{t.get('priority','?')}] {t['text']}" + (f" ({r})" if r else ""))

            prompt = (
                f"{tone}\n\n"
                f"Write a single short paragraph (2–3 sentences) as a daily briefing for {person}. It should:\n"
                f"- Acknowledge the most important thing on their list\n"
                f"- Be warm but not over the top\n"
                f"- NOT list the todos — just set the tone\n"
                f"- Be written in second person (you/your)\n\n"
                f"Their todos:\n" + "\n".join(todo_lines) + "\n\n"
                f"Return only the paragraph."
            )

            try:
                msg = ai.messages.create(
                    model="claude-haiku-4-5-20251001",
                    max_tokens=150,
                    messages=[{"role": "user", "content": prompt}],
                )
                blurb = msg.content[0].text.strip()
            except Exception as e:
                print(f"Blurb generation failed for {person}: {e}")
                continue

        supa.table("person_blurbs").upsert({
            "person_name": person,
            "blurb": blurb,
            "updated_at": now,
        }).execute()
        print(f"Blurb saved for {person}.")


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    supa = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    ai   = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    prioritise(supa, ai)
    generate_blurbs(supa, ai)
    print("Done.")


if __name__ == "__main__":
    main()
