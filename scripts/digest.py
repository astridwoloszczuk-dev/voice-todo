#!/usr/bin/env python3
"""Daily digest: send personalised WhatsApp messages to each family member."""

import os
from datetime import date, datetime, timezone

import anthropic
import requests
from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")  # optional — skips intros if missing
NTFY_TOPIC = os.environ["NTFY_TOPIC"]

# Ages used to calibrate tone in the personalised intro
CHILD_AGES = {
    "Max": 15,
    "Alex": 13,
    "Vicky": 11,
}

PRIORITY_ORDER = {"high": 0, "medium": 1, "low": 2, "someday": 3}


def get_person_todos(supa, person_id):
    """Fetch accepted pending todos for one person, sorted by priority."""
    resp = (
        supa.table("todos")
        .select("id, text, priority, priority_reasoning, notes")
        .eq("assigned_to", person_id)
        .eq("status", "pending")
        .eq("assignment_status", "accepted")
        .execute()
    )
    todos = resp.data or []
    todos.sort(key=lambda t: PRIORITY_ORDER.get(t.get("priority"), 99))
    return todos


def format_whatsapp_message(name, todos, intro=None):
    """Assemble the full WhatsApp digest: optional Claude intro + structured list."""
    if not todos:
        return f"Good morning {name}! No pending todos today. 🎉"

    parts = []
    if intro:
        parts.append(intro)
        parts.append("")  # blank line before list
    else:
        parts.append(f"Good morning {name}! Your todos for today:")
        parts.append("")

    parts.append(build_todo_list(todos))
    return "\n".join(parts).strip()


def generate_intro(ai, person, todos):
    """Ask Claude to write a short personalised intro paragraph for this person's digest."""
    name = person["name"]
    role = person.get("role", "parent")
    age = CHILD_AGES.get(name)

    if role == "parent":
        tone_guidance = f"{name} is a parent. Be direct and concise — they want the headline, not a pep talk."
    else:
        tone_guidance = (
            f"{name} is {age} years old. Use a friendly, age-appropriate tone. "
            f"Keep it short and warm, not preachy."
        )

    todo_lines = []
    for t in todos:
        reasoning = t.get("priority_reasoning") or ""
        notes = t.get("notes") or ""
        extra = f" ({reasoning})" if reasoning else ""
        extra += f" — note: {notes}" if notes else ""
        todo_lines.append(f"  [{t.get('priority', '?')}] {t['text']}{extra}")
    todo_text = "\n".join(todo_lines) if todo_lines else "  (no todos)"

    prompt = (
        f"{tone_guidance}\n\n"
        f"Write a single short paragraph (2–3 sentences max) as the opening of a WhatsApp morning "
        f"message for {name}. It should:\n"
        f"- Acknowledge the most important thing on their list today (use the priority_reasoning if helpful)\n"
        f"- Be warm but not over the top\n"
        f"- NOT repeat or list the todos — the full list follows immediately after\n\n"
        f"Their todos:\n{todo_text}\n\n"
        f"Return only the paragraph, no greeting, no sign-off."
    )

    try:
        msg = ai.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=120,
            messages=[{"role": "user", "content": prompt}],
        )
        return msg.content[0].text.strip()
    except Exception as e:
        print(f"  Claude intro failed for {name}: {e} — using static format only.")
        return None


def build_todo_list(todos):
    """Format the structured todo list section with numbers for completion replies."""
    if not todos:
        return ""

    lines = []
    labels = {"high": "High priority", "medium": "Medium", "low": "Low", "someday": "Someday"}
    by_priority = {}
    for t in todos:
        p = t.get("priority") or "someday"
        by_priority.setdefault(p, []).append(t)

    # Todos are pre-sorted by priority — number them in that order
    counter = 1
    for level in ["high", "medium", "low", "someday"]:
        items = by_priority.get(level, [])
        if not items:
            continue
        lines.append(f"*{labels[level]}*")
        for t in items:
            lines.append(f"{counter}. {t['text']}")
            counter += 1
        lines.append("")

    lines.append("_Reply with numbers to tick off, e.g. 1 3_")
    return "\n".join(lines).strip()


def send_whatsapp(supa, number, message):
    """Queue a WhatsApp message for sending via the whatsapp-server Node process."""
    supa.table("outbound_messages").insert({
        "to_number": number,
        "message": message,
    }).execute()


def send_poll(number, person_name, priority_level, todos):
    """Send a completion poll for one priority level.
    TODO: implement WhatsApp polls via whatsapp-web.js Poll message type.
    """
    options = [t["text"][:100] for t in todos]
    print(f"[Poll stub → {number}] {priority_level}: {options}")


def record_poll_send(supa, run_id, person_id, priority_level, todos):
    """Record the poll send in Supabase so responses can be matched back."""
    options = [{"text": t["text"][:100], "todo_id": t["id"]} for t in todos]
    supa.table("poll_sends").insert({
        "digest_run_id": run_id,
        "person_id": person_id,
        "priority_level": priority_level,
        "options": options,
    }).execute()


def send_ntfy_summary(topic, people_summaries, total_todos):
    """Send master overview to Astrid via ntfy."""
    lines = [f"Family digest sent — {total_todos} pending todos\n"]
    for name, count, high_count in people_summaries:
        high_note = f", {high_count} high" if high_count > 0 else ""
        lines.append(f"• {name}: {count} todo{'s' if count != 1 else ''}{high_note}")

    requests.post(
        f"https://ntfy.sh/{topic}",
        data="\n".join(lines).encode("utf-8"),
        headers={"Title": "Family Digest", "Tags": "family", "Priority": "default"},
        timeout=10,
    )
    print("ntfy master summary sent.")


def main():
    supa = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    ai = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY) if ANTHROPIC_API_KEY else None
    today = date.today().isoformat()

    # Guard: skip if digest already ran today
    existing = supa.table("digest_runs").select("id, status").eq("run_date", today).execute()
    if existing.data:
        print(f"Digest already ran today ({existing.data[0]['status']}) — skipping.")
        return

    # Create digest run record
    run = supa.table("digest_runs").insert({"run_date": today, "status": "pending"}).execute()
    run_id = run.data[0]["id"]
    print(f"Digest run {run_id} — {today}")

    people_resp = supa.table("people").select("*").eq("is_active", True).eq("is_bot", False).execute()
    people = people_resp.data or []

    people_summaries = []
    total_todos = 0

    try:
        for person in people:
            name = person["name"]
            number = person.get("whatsapp_number")
            todos = get_person_todos(supa, person["id"])

            count = len(todos)
            high_count = sum(1 for t in todos if t.get("priority") == "high")
            total_todos += count
            people_summaries.append((name, count, high_count))
            print(f"{name}: {count} todos ({high_count} high)")

            if not number:
                print(f"  No WhatsApp number for {name} — skipping send.")
                continue

            # Generate personalised intro (falls back to None if API fails)
            intro = generate_intro(ai, person, todos) if todos else None

            # Send digest message
            send_whatsapp(supa, number, format_whatsapp_message(name, todos, intro))

            # Send completion polls, one per priority level that has items
            for level in ["high", "medium", "low"]:
                level_todos = [t for t in todos if t.get("priority") == level]
                if level_todos:
                    send_poll(number, name, level, level_todos)
                    record_poll_send(supa, run_id, person["id"], level, level_todos)

        # Send ntfy master summary to whoever has an ntfy_topic (Astrid)
        ntfy_person = next((p for p in people if p.get("ntfy_topic")), None)
        if ntfy_person:
            send_ntfy_summary(ntfy_person["ntfy_topic"], people_summaries, total_todos)

        # Mark complete
        supa.table("digest_runs").update({
            "status": "sent",
            "sent_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", run_id).execute()
        print("Done.")

    except Exception as e:
        supa.table("digest_runs").update({"status": "failed"}).eq("id", run_id).execute()
        raise


if __name__ == "__main__":
    main()
