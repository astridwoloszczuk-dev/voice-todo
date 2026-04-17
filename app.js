'use strict';

const SUPABASE_URL = 'https://mezayharkjyvnnhvdlww.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lemF5aGFya2p5dm5uaHZkbHd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTE2ODQsImV4cCI6MjA5MTY2NzY4NH0.GlyIlgobMa0lVjEhH59-Zu1mt3f_usAipFNsg0bJSqE';
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2, someday: 3 };

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const app = {
  person: null,   // { id, name, role }
  todos: [],

  // ── Boot ──────────────────────────────────────────────────────────────────
  async init() {
    const saved = localStorage.getItem('family_person');
    if (saved) {
      try {
        this.person = JSON.parse(saved);
        this.showMain();
        await this.load();
        return;
      } catch (e) {
        localStorage.removeItem('family_person');
      }
    }
    await this.showPicker();
  },

  // ── Person picker ──────────────────────────────────────────────────────────
  async showPicker() {
    const { data: people } = await db
      .from('people')
      .select('id, name, role')
      .eq('is_active', true)
      .eq('is_bot', false)
      .order('name');

    const list = document.getElementById('pick-list');
    list.innerHTML = '';
    for (const p of people || []) {
      const btn = document.createElement('button');
      btn.className = 'pick-btn';
      btn.textContent = p.name;
      btn.onclick = () => this.selectPerson(p);
      list.appendChild(btn);
    }

    show('screen-pick');
    hide('screen-main');
  },

  selectPerson(person) {
    this.person = person;
    localStorage.setItem('family_person', JSON.stringify(person));
    this.showMain();
    this.load();
  },

  switchPerson() {
    localStorage.removeItem('family_person');
    this.person = null;
    this.showPicker();
  },

  showMain() {
    hide('screen-pick');
    show('screen-main');
    document.getElementById('header-name').textContent = this.person.name;
  },

  // ── Data ──────────────────────────────────────────────────────────────────
  async load() {
    if (!this.person) return;

    // Todos
    const { data: todos, error } = await db
      .from('todos')
      .select('id, text, priority, notes')
      .eq('assigned_to', this.person.id)
      .eq('status', 'pending')
      .eq('assignment_status', 'accepted');

    if (error) { this.toast('Failed to load todos'); return; }

    this.todos = (todos || []).sort((a, b) =>
      (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99)
    );

    // Today's Claude intro
    const today = new Date().toISOString().slice(0, 10);
    const { data: digest } = await db
      .from('person_digests')
      .select('intro_text')
      .eq('person_id', this.person.id)
      .eq('digest_date', today)
      .maybeSingle();

    this.render(digest?.intro_text || null);
  },

  // ── Render ────────────────────────────────────────────────────────────────
  render(intro) {
    // Intro card
    const introCard = document.getElementById('intro-card');
    const introText = document.getElementById('intro-text');
    if (intro) {
      introText.textContent = intro;
      introCard.classList.remove('hidden');
    } else {
      introCard.classList.add('hidden');
    }

    // Todo list
    const list = document.getElementById('todo-list');
    const empty = document.getElementById('empty-state');

    if (!this.todos.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');

    const labels = { high: 'High priority', medium: 'Medium', low: 'Low', someday: 'Someday' };
    const byPriority = {};
    for (const t of this.todos) {
      const p = t.priority || 'someday';
      (byPriority[p] = byPriority[p] || []).push(t);
    }

    let html = '';
    let num = 1;
    for (const level of ['high', 'medium', 'low', 'someday']) {
      const items = byPriority[level];
      if (!items) continue;
      html += `<div class="priority-group">
        <div class="priority-label priority-${level}">${labels[level]}</div>`;
      for (const t of items) {
        html += `<div class="todo-row" data-id="${t.id}" onclick="app.complete('${t.id}')">
          <div class="todo-check"></div>
          <div class="todo-body">
            <span class="todo-num">${num}.</span>
            <span class="todo-text">${escHtml(t.text)}</span>
            ${t.notes ? `<span class="todo-notes">${escHtml(t.notes)}</span>` : ''}
          </div>
        </div>`;
        num++;
      }
      html += `</div>`;
    }

    list.innerHTML = html;
  },

  // ── Complete ──────────────────────────────────────────────────────────────
  async complete(id) {
    // Animate immediately
    const row = document.querySelector(`.todo-row[data-id="${id}"]`);
    if (row) {
      row.classList.add('completing');
      setTimeout(() => row.remove(), 350);
    }

    // Remove from local state
    this.todos = this.todos.filter(t => t.id !== id);
    if (!this.todos.length) {
      document.getElementById('empty-state').classList.remove('hidden');
    }

    // Update Supabase
    const { error } = await db
      .from('todos')
      .update({ status: 'done', updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      this.toast('Could not save — try again');
      this.load(); // re-fetch to restore accurate state
    }
  },

  // ── Utils ─────────────────────────────────────────────────────────────────
  toast(msg, duration = 2500) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), duration);
  },
};

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

app.init();
