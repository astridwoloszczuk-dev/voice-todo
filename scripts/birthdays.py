#!/usr/bin/env python3
"""
Birthday reminders via WhatsApp.

Schedule:
  - Evening before (e.g. 19:00): send "tomorrow is X's birthday"
  - Morning of (e.g. 07:00):     send "today is X's birthday" — repeats every 3 hours
                                  until an ack exists for today

Run this script at every reminder window via cron:
  0 19 * * *  cd /root/todo-list/scripts && python3 birthdays.py evening
  0  7 * * *  cd /root/todo-list/scripts && python3 birthdays.py daytime
  0 10 * * *  cd /root/todo-list/scripts && python3 birthdays.py daytime
  0 13 * * *  cd /root/todo-list/scripts && python3 birthdays.py daytime
  0 16 * * *  cd /root/todo-list/scripts && python3 birthdays.py daytime
"""

import os
import sys
from datetime import date, timedelta

from supabase import create_client

SUPABASE_URL        = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]


def send_whatsapp(supa, number, message):
    supa.table("outbound_messages").insert({
        "to_number": number,
        "message":   message,
    }).execute()


def get_whatsapp_number(supa, person_name):
    resp = supa.table("people").select("whatsapp_number").eq("name", person_name).execute()
    if resp.data:
        return resp.data[0].get("whatsapp_number")
    return None


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "daytime"
    supa = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    today    = date.today()
    tomorrow = today + timedelta(days=1)

    today_mmdd    = today.strftime("%m-%d")
    tomorrow_mmdd = tomorrow.strftime("%m-%d")

    if mode == "evening":
        # Find birthdays tomorrow
        resp = supa.table("birthdays").select("id, name").eq("birth_date", tomorrow_mmdd).execute()
        birthdays = resp.data or []

        for bday in birthdays:
            # Who should be reminded?
            rem = supa.table("birthday_reminders").select("person_name").eq("birthday_id", bday["id"]).execute()
            recipients = [r["person_name"] for r in (rem.data or [])]

            for person in recipients:
                number = get_whatsapp_number(supa, person)
                if not number:
                    print(f"  No WhatsApp number for {person} — skipping.")
                    continue
                msg = f"Tomorrow is {bday['name']}'s birthday! 🎂 Don't forget to wish them well!"
                send_whatsapp(supa, number, msg)
                print(f"  Evening reminder → {person} for {bday['name']}'s birthday tomorrow.")

    else:
        # daytime run — send if today is the birthday AND not yet acked
        resp = supa.table("birthdays").select("id, name").eq("birth_date", today_mmdd).execute()
        birthdays = resp.data or []

        for bday in birthdays:
            # Check if already acked today
            ack = supa.table("birthday_acks").select("id").eq("birthday_id", bday["id"]).eq("ack_date", today.isoformat()).execute()
            if ack.data:
                print(f"  {bday['name']}'s birthday already acked — skipping.")
                continue

            # Who should be reminded?
            rem = supa.table("birthday_reminders").select("person_name").eq("birthday_id", bday["id"]).execute()
            recipients = [r["person_name"] for r in (rem.data or [])]

            for person in recipients:
                number = get_whatsapp_number(supa, person)
                if not number:
                    print(f"  No WhatsApp number for {person} — skipping.")
                    continue
                msg = f"Today is {bday['name']}'s birthday! 🎂 Have you wished them yet? Reply 'done' or confirm in the app."
                send_whatsapp(supa, number, msg)
                print(f"  Daytime reminder → {person} for {bday['name']}'s birthday today.")

    print("Done.")


if __name__ == "__main__":
    main()
