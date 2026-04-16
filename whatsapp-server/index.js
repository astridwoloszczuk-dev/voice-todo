'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const POLL_INTERVAL_MS = 30_000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const ai = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// ── People cache (refreshed every 5 min) ────────────────────────────────────
let _people = [];
let _peopleFetchedAt = 0;

async function getPeople() {
  if (Date.now() - _peopleFetchedAt > 5 * 60 * 1000) {
    const { data } = await supa.from('people').select('*').eq('is_active', true);
    if (data) { _people = data; _peopleFetchedAt = Date.now(); }
  }
  return _people;
}

async function findPersonByNumber(number) {
  const people = await getPeople();
  return people.find(p => p.whatsapp_number === number && !p.is_bot) || null;
}

const NAME_ALIASES = {
  mum: 'Astrid', mom: 'Astrid', mama: 'Astrid', mother: 'Astrid',
  dad: 'Niko', papa: 'Niko', father: 'Niko',
};

async function findPersonByName(name) {
  const people = await getPeople();
  const resolved = NAME_ALIASES[name.toLowerCase()] || name;
  return people.find(p => p.name.toLowerCase() === resolved.toLowerCase() && !p.is_bot) || null;
}

// ── Number helpers ───────────────────────────────────────────────────────────
function waIdToE164(waId) {
  return '+' + waId.split('@')[0];
}

function e164ToWaId(e164) {
  return e164.replace('+', '') + '@c.us';
}

async function resolveNumber(message) {
  if (message.from.endsWith('@lid')) {
    try {
      const contact = await message.getContact();
      return '+' + contact.number;
    } catch (e) {
      console.log(`Could not resolve LID ${message.from}: ${e.message}`);
      return null;
    }
  }
  return waIdToE164(message.from);
}

// ── Messaging ────────────────────────────────────────────────────────────────
async function send(client, number, message) {
  await client.sendMessage(e164ToWaId(number), message);
}

// ── Assignment rules ─────────────────────────────────────────────────────────
function isAutoAccept(sender, target) {
  if (sender.id === target.id) return true;
  if (sender.role === 'parent' && target.role === 'child') return true;
  return false;
}

// ── Pending actions ──────────────────────────────────────────────────────────
async function createPendingAction(personId, todoId, type, options) {
  await supa.from('pending_actions').delete()
    .eq('person_id', personId).eq('todo_id', todoId);
  await supa.from('pending_actions').insert({ person_id: personId, todo_id: todoId, type, options });
}

async function getPendingAction(personId) {
  const { data } = await supa.from('pending_actions').select('*')
    .eq('person_id', personId).order('created_at', { ascending: true }).limit(1);
  return data?.[0] || null;
}

async function getRefusedIds(todoId) {
  const { data } = await supa.from('todo_refusals').select('person_id').eq('todo_id', todoId);
  return new Set((data || []).map(r => r.person_id));
}

// ── Message builders ─────────────────────────────────────────────────────────
function buildAcceptRefuseMsg(todoText, assignerName) {
  return `📋 *${assignerName}* assigned you:\n"${todoText}"\n\nReply:\n1️⃣ Accept\n2️⃣ Refuse`;
}

async function buildReassignOptions(todo, justRefusedId) {
  const people = await getPeople();
  const refusedIds = await getRefusedIds(todo.id);
  refusedIds.add(justRefusedId);

  const creator = people.find(p => p.id === todo.created_by);
  const options = [];
  let num = 1;

  if (creator && !refusedIds.has(creator.id)) {
    options.push({ number: num++, label: `Take it myself (${creator.name})`, action: 'self' });
  }

  for (const p of people) {
    if (p.is_bot) continue;
    if (p.id === creator?.id) continue;
    if (refusedIds.has(p.id)) continue;
    options.push({ number: num++, label: p.name, action: 'assign', target_id: p.id });
  }

  options.push({ number: num++, label: '🗑️ Delete task', action: 'delete' });
  return options;
}

// ── Send assignment request ──────────────────────────────────────────────────
async function requestAcceptance(client, todo, assigner, target) {
  if (!target.whatsapp_number) return;
  await send(client, target.whatsapp_number, buildAcceptRefuseMsg(todo.text, assigner.name));
  await createPendingAction(target.id, todo.id, 'accept_refuse', [
    { number: 1, label: 'Accept', action: 'accept' },
    { number: 2, label: 'Refuse', action: 'refuse' },
  ]);
}

// ── Handle a pending action response ────────────────────────────────────────
async function handlePendingAction(client, person, text) {
  const pending = await getPendingAction(person.id);
  if (!pending) return false;

  const num = parseInt(text.trim(), 10);
  if (isNaN(num) || text.trim().length > 2) return false;

  const option = pending.options.find(o => o.number === num);
  if (!option) {
    await send(client, person.whatsapp_number, `Please reply with one of the listed numbers.`);
    return true;
  }

  const { data: rows } = await supa.from('todos').select('*').eq('id', pending.todo_id).limit(1);
  const todo = rows?.[0];
  if (!todo) {
    await supa.from('pending_actions').delete().eq('id', pending.id);
    return true;
  }

  if (pending.type === 'accept_refuse') {
    await handleAcceptRefuse(client, person, todo, option, pending);
  } else if (pending.type === 'reassign') {
    await handleReassign(client, person, todo, option);
  }

  const next = await getPendingAction(person.id);
  if (next) {
    const { data: nextRows } = await supa.from('todos').select('*').eq('id', next.todo_id).limit(1);
    const nextTodo = nextRows?.[0];
    if (nextTodo) {
      const people = await getPeople();
      const assigner = people.find(p => p.id === nextTodo.created_by);
      await send(client, person.whatsapp_number,
        buildAcceptRefuseMsg(nextTodo.text, assigner?.name || 'Someone'));
    }
  }

  return true;
}

async function handleAcceptRefuse(client, person, todo, option, pending) {
  const people = await getPeople();

  if (option.action === 'accept') {
    await supa.from('todos').update({ assignment_status: 'accepted' }).eq('id', todo.id);
    await supa.from('pending_actions').delete().eq('id', pending.id);
    await send(client, person.whatsapp_number, `✅ Accepted: "${todo.text}"`);

    const creator = people.find(p => p.id === todo.created_by);
    if (creator && creator.id !== person.id && creator.whatsapp_number) {
      await send(client, creator.whatsapp_number, `✅ ${person.name} accepted: "${todo.text}"`);
    }
    console.log(`[${person.name}] Accepted: ${todo.text.slice(0, 50)}`);

  } else if (option.action === 'refuse') {
    await supa.from('todo_refusals').insert({ todo_id: todo.id, person_id: person.id });
    await supa.from('pending_actions').delete().eq('id', pending.id);
    await send(client, person.whatsapp_number, `❌ Refused: "${todo.text}"`);

    const creator = people.find(p => p.id === todo.created_by);
    if (!creator?.whatsapp_number) return;

    const options = await buildReassignOptions(todo, person.id);
    const lines = [`❌ *${person.name}* refused:\n"${todo.text}"\n\nAssign to:`];
    options.forEach(o => lines.push(`${o.number}️⃣ ${o.label}`));
    await send(client, creator.whatsapp_number, lines.join('\n'));
    await createPendingAction(creator.id, todo.id, 'reassign', options);
    console.log(`[${person.name}] Refused: ${todo.text.slice(0, 50)}`);
  }
}

async function handleReassign(client, person, todo, option) {
  const people = await getPeople();
  await supa.from('pending_actions').delete().eq('person_id', person.id).eq('todo_id', todo.id);

  if (option.action === 'self') {
    await supa.from('todos')
      .update({ assigned_to: person.id, assignment_status: 'accepted' })
      .eq('id', todo.id);
    await send(client, person.whatsapp_number, `✅ You'll handle: "${todo.text}"`);
    console.log(`[${person.name}] Took task: ${todo.text.slice(0, 50)}`);

  } else if (option.action === 'assign') {
    const target = people.find(p => p.id === option.target_id);
    if (!target) return;

    const autoAccept = isAutoAccept(person, target);
    await supa.from('todos')
      .update({ assigned_to: target.id, assignment_status: autoAccept ? 'accepted' : 'pending' })
      .eq('id', todo.id);

    if (autoAccept) {
      await send(client, person.whatsapp_number, `✅ Assigned to ${target.name}: "${todo.text}"`);
      if (target.whatsapp_number) {
        await send(client, target.whatsapp_number, `📋 *${person.name}* assigned you: "${todo.text}"`);
      }
    } else {
      await send(client, person.whatsapp_number, `📤 Sent to ${target.name} for acceptance`);
      await requestAcceptance(client, todo, person, target);
    }
    console.log(`[${person.name}→${target.name}] Reassigned: ${todo.text.slice(0, 50)}`);

  } else if (option.action === 'delete') {
    await supa.from('todos')
      .update({ status: 'deleted', deleted_at: new Date().toISOString() })
      .eq('id', todo.id);
    await send(client, person.whatsapp_number, `🗑️ Deleted: "${todo.text}"`);
    console.log(`[${person.name}] Deleted: ${todo.text.slice(0, 50)}`);
  }
}

// ── Todo operations ──────────────────────────────────────────────────────────
async function addSelfTodo(client, person, text) {
  const { error } = await supa.from('todos').insert({
    text,
    created_by: person.id,
    assigned_to: person.id,
    assignment_status: 'accepted',
    status: 'pending',
    processed: 0,
  });
  if (error) {
    console.error(`Failed to save todo for ${person.name}:`, error.message);
    await send(client, person.whatsapp_number, 'Sorry, something went wrong. Try again?');
    return;
  }
  console.log(`[${person.name}] Todo added: ${text.slice(0, 60)}`);
  await send(client, person.whatsapp_number, 'Got it ✓ Added to your todos.');
}

async function addAssignedTodo(client, person, targetName, taskText) {
  const target = await findPersonByName(targetName);
  if (!target || target.id === person.id) return false;

  const autoAccept = isAutoAccept(person, target);
  const { data: inserted, error } = await supa.from('todos').insert({
    text: taskText,
    created_by: person.id,
    assigned_to: target.id,
    assignment_status: autoAccept ? 'accepted' : 'pending',
    status: 'pending',
    processed: 0,
  }).select().single();

  if (error) {
    console.error('Insert error:', error.message);
    await send(client, person.whatsapp_number, 'Sorry, something went wrong.');
    return true;
  }

  if (autoAccept) {
    await send(client, person.whatsapp_number, `✅ Assigned to ${target.name}: "${taskText}"`);
    if (target.whatsapp_number) {
      await send(client, target.whatsapp_number, `📋 *${person.name}* assigned you: "${taskText}"`);
    }
  } else {
    await send(client, person.whatsapp_number, `📤 Sent to ${target.name} for acceptance`);
    await requestAcceptance(client, inserted, person, target);
  }

  console.log(`[${person.name}→${target.name}] ${autoAccept ? 'Auto-accepted' : 'Pending'}: ${taskText.slice(0, 50)}`);
  return true;
}

// ── Completion: mark numbered todos as done ──────────────────────────────────
// Format: pure numbers, e.g. "1", "1 3", "2 4 5"
// Matches against today's digest order (high→medium→low)
async function handleCompletion(client, person, numbers) {
  const PRIORITY_ORDER = { high: 0, medium: 1, low: 2, someday: 3 };

  const { data: todos } = await supa.from('todos')
    .select('id, text, priority')
    .eq('assigned_to', person.id)
    .eq('status', 'pending')
    .eq('assignment_status', 'accepted');

  if (!todos?.length) {
    await send(client, person.whatsapp_number, 'No pending todos to mark as done.');
    return;
  }

  todos.sort((a, b) =>
    (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99)
  );

  const done = [];
  const invalid = [];

  for (const n of numbers) {
    const idx = n - 1;
    if (idx < 0 || idx >= todos.length) {
      invalid.push(n);
    } else {
      done.push(todos[idx]);
    }
  }

  if (!done.length) {
    await send(client, person.whatsapp_number, `No matching todos (you have ${todos.length}).`);
    return;
  }

  const now = new Date().toISOString();
  for (const t of done) {
    await supa.from('todos').update({ status: 'done', updated_at: now }).eq('id', t.id);
  }

  const lines = done.map(t => `✅ ${t.text}`);
  if (invalid.length) lines.push(`\n(Numbers not found: ${invalid.join(', ')})`);
  await send(client, person.whatsapp_number, lines.join('\n'));
  console.log(`[${person.name}] Completed ${done.length} todo(s): ${done.map(t => t.text.slice(0,30)).join(', ')}`);
}

// ── Claude brain: classify inbound intent ────────────────────────────────────
// Uses prompt caching on the system prompt to keep costs low.

const BRAIN_SYSTEM = `You are the inbox router for a family WhatsApp todo system. Your job is to classify each incoming message into exactly one intent.

Intents:
- add_todo: The person wants to add a task/todo for themselves (most common)
- assign_todo: The message starts with a family member's name followed by a colon, e.g. "Max: clean room"
- complete_todos: The message is purely numbers, e.g. "1", "1 3 5", "done 2" — marking todos as completed
- diary: The message is about calendar, schedule, appointments, or events (adding, moving, cancelling)
- unknown: Anything else (greetings, questions, gibberish)

Family members: Astrid (mum), Niko (dad), Max (15), Alex (13), Vicky (11).

Rules:
- If the message is ONLY digits and spaces, intent is complete_todos
- If it starts with a name + colon, intent is assign_todo
- Calendar/diary/appointment/schedule words → intent is diary
- Everything else is add_todo

Respond with ONLY a JSON object, no explanation:
{"intent": "add_todo", "task": "the todo text"}
{"intent": "assign_todo", "target": "Max", "task": "clean your room"}
{"intent": "complete_todos", "numbers": [1, 3]}
{"intent": "diary", "request": "the original request text"}
{"intent": "unknown"}`;

async function classifyMessage(person, text) {
  // Fast path: pure numbers — no API call needed
  if (/^\d[\d\s]*$/.test(text.trim())) {
    const numbers = text.trim().split(/\s+/).map(Number);
    return { intent: 'complete_todos', numbers };
  }

  // Fast path: "Name: task" pattern — no API call needed
  const assignMatch = text.match(/^(\w+)\s*:\s*(.+)$/s);
  if (assignMatch) {
    return { intent: 'assign_todo', target: assignMatch[1].trim(), task: assignMatch[2].trim() };
  }

  // Use Claude if available, otherwise default to add_todo
  if (!ai) {
    return { intent: 'add_todo', task: text };
  }

  try {
    const response = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: [
        {
          type: 'text',
          text: BRAIN_SYSTEM,
          cache_control: { type: 'ephemeral' },
        }
      ],
      messages: [
        { role: 'user', content: `Sender: ${person.name} (${person.role})\nMessage: ${text}` },
      ],
    });

    const raw = response.content[0].text.trim();
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Claude classification failed: ${e.message} — defaulting to add_todo`);
    return { intent: 'add_todo', task: text };
  }
}

// ── Main inbound handler ─────────────────────────────────────────────────────
async function handleInbound(client, message) {
  const text = message.body.trim();
  if (!text) return;

  const number = await resolveNumber(message);
  if (!number) return;

  const person = await findPersonByNumber(number);
  if (!person) {
    console.log(`Ignored message from unknown number: ${number}`);
    return;
  }

  // Pending action responses (numbered replies within an active dialogue) take priority
  const handled = await handlePendingAction(client, person, text);
  if (handled) return;

  // Classify intent
  const classified = await classifyMessage(person, text);
  console.log(`[${person.name}] intent=${classified.intent} | "${text.slice(0, 60)}"`);

  switch (classified.intent) {
    case 'complete_todos':
      await handleCompletion(client, person, classified.numbers);
      break;

    case 'assign_todo': {
      const assigned = await addAssignedTodo(client, person, classified.target, classified.task);
      if (!assigned) {
        // Target not found or is self — treat as self-todo with full text
        await addSelfTodo(client, person, text);
      }
      break;
    }

    case 'diary':
      // Stub — full diary integration coming soon
      await send(client, person.whatsapp_number,
        '📅 Diary integration coming soon! For now, email claude.w.lowndes@gmail.com for calendar requests.');
      console.log(`[${person.name}] Diary request (stub): ${text.slice(0, 60)}`);
      break;

    case 'add_todo':
      await addSelfTodo(client, person, classified.task || text);
      break;

    default:
      await addSelfTodo(client, person, text);
      break;
  }
}

// ── Outbound message queue ───────────────────────────────────────────────────
async function sendPending(client) {
  const { data: messages, error } = await supa
    .from('outbound_messages').select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) { console.error('Outbound poll error:', error.message); return; }
  if (!messages?.length) return;

  console.log(`Sending ${messages.length} pending message(s)...`);
  for (const msg of messages) {
    try {
      await client.sendMessage(e164ToWaId(msg.to_number), msg.message);
      await supa.from('outbound_messages')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', msg.id);
      console.log(`  Sent to ${msg.to_number}: ${msg.message.slice(0, 60)}`);
    } catch (e) {
      console.error(`  Failed to send to ${msg.to_number}:`, e.message);
      await supa.from('outbound_messages')
        .update({ status: 'failed', error: e.message })
        .eq('id', msg.id);
    }
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
async function main() {
  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      executablePath: '/usr/bin/google-chrome-stable',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', qr => {
    console.log('\nScan this QR code in WhatsApp on the iPhone:');
    console.log('(WhatsApp → Settings → Linked Devices → Link a Device)\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    console.log('WhatsApp connected and ready.');
    if (ai) {
      console.log('Claude brain: active (prompt caching on)');
    } else {
      console.log('Claude brain: disabled (no ANTHROPIC_API_KEY) — using pattern matching only');
    }
    sendPending(client);
    setInterval(() => sendPending(client), POLL_INTERVAL_MS);
  });

  client.on('message', async message => {
    if (message.from.endsWith('@g.us')) return;
    if (message.from === 'status@broadcast') return;
    await handleInbound(client, message);
  });

  client.on('disconnected', reason => {
    console.warn('WhatsApp disconnected:', reason);
    process.exit(1);
  });

  await client.initialize();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
