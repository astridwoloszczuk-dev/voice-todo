#!/usr/bin/env bash
# Add a todo to Voice Todo Cloud from the terminal.
# Usage: ./todo.sh "your task here"

SUPABASE_URL="https://mezayharkjyvnnhvdlww.supabase.co"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lemF5aGFya2p5dm5uaHZkbHd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTE2ODQsImV4cCI6MjA5MTY2NzY4NH0.GlyIlgobMa0lVjEhH59-Zu1mt3f_usAipFNsg0bJSqE"

if [[ -z "$1" ]]; then
  echo "Usage: todo.sh \"your task here\""
  exit 1
fi

RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "${SUPABASE_URL}/rest/v1/todos" \
  -H "apikey: ${ANON_KEY}" \
  -H "Authorization: Bearer ${ANON_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
  -d "{\"text\": $(echo "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')}")

if [[ "$RESPONSE" == "201" ]]; then
  echo "Added: $1"
else
  echo "Error (HTTP $RESPONSE)"
fi
