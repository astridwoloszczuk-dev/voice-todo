'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const POLL_INTERVAL_MS = 30_000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Convert whatsapp-web.js "from" field (e.g. "436766641990@c.us") to E.164 ("+436766641990")
function waIdToE164(waId) {
  return '+' + waId.split('@')[0];
}

// Convert E.164 ("+436766641990") to whatsapp-web.js chat ID ("436766641990@c.us")
function e164ToWaId(e164) {
  return e164.replace('+', '') + '@c.us';
}

async function handleInbound(message) {
  const text = message.body.trim();
  if (!text) return;

  console.log(`DEBUG from=${message.from} author=${message.author} to=${message.to} body=${text.slice(0, 50)}`);

  const number = waIdToE164(message.from);

  // Look up sender in people table
  const { data: people, error } = await supa
    .from('people')
    .select('id, name')
    .eq('whatsapp_number', number)
    .eq('is_active', true)
    .eq('is_bot', false)
    .limit(1);

  if (error) {
    console.error('Supabase lookup error:', error.message);
    return;
  }

  if (!people?.length) {
    console.log(`Ignored message from unknown number: ${number}`);
    return;
  }

  const person = people[0];

  const { error: insertError } = await supa.from('todos').insert({
    text,
    created_by: person.id,
    assigned_to: person.id,
    assignment_status: 'accepted',
    status: 'pending',
    processed: 0,
  });

  if (insertError) {
    console.error(`Failed to save todo for ${person.name}:`, insertError.message);
    await message.reply('Sorry, something went wrong saving that. Try again?');
    return;
  }

  console.log(`[${person.name}] Todo added: ${text.slice(0, 60)}`);
  await message.reply('Got it \u2713 Added to your todos.');
}

async function sendPending(client) {
  const { data: messages, error } = await supa
    .from('outbound_messages')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Outbound poll error:', error.message);
    return;
  }

  if (!messages?.length) return;

  console.log(`Sending ${messages.length} pending message(s)...`);

  for (const msg of messages) {
    try {
      const chatId = e164ToWaId(msg.to_number);
      await client.sendMessage(chatId, msg.message);

      await supa.from('outbound_messages').update({
        status: 'sent',
        sent_at: new Date().toISOString(),
      }).eq('id', msg.id);

      console.log(`  Sent to ${msg.to_number}: ${msg.message.slice(0, 60)}`);
    } catch (e) {
      console.error(`  Failed to send to ${msg.to_number}:`, e.message);
      await supa.from('outbound_messages').update({
        status: 'failed',
        error: e.message,
      }).eq('id', msg.id);
    }
  }
}

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
    sendPending(client);
    setInterval(() => sendPending(client), POLL_INTERVAL_MS);
  });

  client.on('message', async message => {
    // Ignore group messages and broadcast/status
    if (message.from.endsWith('@g.us')) return;
    if (message.from === 'status@broadcast') return;
    await handleInbound(message);
  });

  client.on('disconnected', reason => {
    console.warn('WhatsApp disconnected:', reason);
    process.exit(1); // PM2 will restart
  });

  await client.initialize();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
