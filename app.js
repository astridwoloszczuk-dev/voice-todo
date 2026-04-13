'use strict';

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://mezayharkjyvnnhvdlww.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lemF5aGFya2p5dm5uaHZkbHd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTE2ODQsImV4cCI6MjA5MTY2NzY4NH0.GlyIlgobMa0lVjEhH59-Zu1mt3f_usAipFNsg0bJSqE';
const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── IndexedDB layer ─────────────────────────────────────────────────────────
const IDB_NAME = 'voicetodo';
const IDB_VERSION = 1;

function dbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains('todos')) {
        idb.createObjectStore('todos', { keyPath: 'id' });
      }
      if (!idb.objectStoreNames.contains('meta')) {
        idb.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function dbSaveTodos(todos) {
  const idb = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('todos', 'readwrite');
    const store = tx.objectStore('todos');
    store.clear();
    for (const todo of todos) store.put(todo);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

async function dbLoadTodos() {
  const idb = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('todos', 'readonly');
    const store = tx.objectStore('todos');
    const req = store.getAll();
    req.onsuccess = () => {
      const todos = req.result || [];
      // Sort: priority nulls last, then by priority asc, then created_at asc
      todos.sort((a, b) => {
        const pa = a.priority == null ? Infinity : a.priority;
        const pb = b.priority == null ? Infinity : b.priority;
        if (pa !== pb) return pa - pb;
        return (a.created_at || '').localeCompare(b.created_at || '');
      });
      resolve(todos);
    };
    req.onerror = e => reject(e.target.error);
  });
}

// ── Offline queue ────────────────────────────────────────────────────────────
const QUEUE_KEY = 'vtodo_offline_queue';

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
function saveQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
function enqueue(text) {
  const q = loadQueue();
  q.push({ text, ts: Date.now() });
  saveQueue(q);
}

// ── App state ────────────────────────────────────────────────────────────────
const app = {
  online: false,
  currentFilter: 'pending',
  currentTodoId: null,
  currentTodo: null,
  calendarLink: null,
  recognition: null,
  recording: false,
  transcript: '',

  // ── Init ─────────────────────────────────────────────────────────────────────
  async init() {
    this.setupSpeech();

    // 1. Show cached data immediately from IndexedDB
    try {
      const cached = await dbLoadTodos();
      const filtered = this.filterTodos(cached, this.currentFilter);
      this.renderTodos(filtered);
    } catch (e) {
      console.warn('IndexedDB load failed:', e);
    }

    // 2. Check online status
    await this.checkOnline();
    setInterval(() => this.checkOnline(), 15000);

    // 3. If online: load fresh data then sync queue
    if (this.online) {
      await this.loadTodos();
      await this.syncQueue();
    }

    this.checkSyncBanner();

    // 4. Register service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/voice-todo/sw.js', { scope: '/voice-todo/' }).catch(console.error);
    }
  },

  // ── Online check ──────────────────────────────────────────────────────────────
  async checkOnline() {
    const dot = document.getElementById('status-dot');
    try {
      const { error } = await db.from('todos').select('id').limit(1);
      this.online = !error;
    } catch {
      this.online = false;
    }
    dot.className = `status-dot ${this.online ? 'online' : 'offline'}`;
    if (this.online) this.checkSyncBanner();
  },

  // ── Views ─────────────────────────────────────────────────────────────────────
  showView(name, btn) {
    document.querySelectorAll('.view').forEach(v => {
      v.classList.add('hidden');
      v.classList.remove('active');
    });
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const view = document.getElementById(`view-${name}`);
    view.classList.remove('hidden');
    view.classList.add('active');
    if (btn) btn.classList.add('active');
    if (name === 'list') this.loadTodos();
    if (name === 'digest') this.loadDigest();
  },

  // ── Filter ───────────────────────────────────────────────────────────────────
  setFilter(status, btn) {
    this.currentFilter = status;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    this.loadTodos();
  },

  filterTodos(todos, status) {
    if (status === 'all') return todos.filter(t => t.status !== 'deleted');
    return todos.filter(t => t.status === status);
  },

  // ── Load todos ────────────────────────────────────────────────────────────────
  async loadTodos() {
    if (!this.online) {
      try {
        const cached = await dbLoadTodos();
        this.renderTodos(this.filterTodos(cached, this.currentFilter));
      } catch {
        this.renderTodos([]);
      }
      return;
    }

    try {
      let query = db.from('todos').select('*').neq('status', 'deleted');
      if (this.currentFilter !== 'all') {
        query = query.eq('status', this.currentFilter);
      }
      // Order by priority asc nulls last, then created_at asc
      query = query.order('priority', { ascending: true, nullsFirst: false })
                   .order('created_at', { ascending: true });

      const { data, error } = await query;
      if (error) throw error;

      const todos = data || [];
      this.renderTodos(todos);

      // Also fetch all non-deleted to keep cache complete
      try {
        const { data: allData } = await db.from('todos').select('*').neq('status', 'deleted');
        if (allData) await dbSaveTodos(allData);
        else await dbSaveTodos(todos);
      } catch {
        await dbSaveTodos(todos);
      }
    } catch (e) {
      console.error('loadTodos error:', e);
      try {
        const cached = await dbLoadTodos();
        this.renderTodos(this.filterTodos(cached, this.currentFilter));
      } catch {
        this.renderTodos([]);
      }
    }
  },

  // ── Render todos ──────────────────────────────────────────────────────────────
  renderTodos(todos) {
    const list = document.getElementById('todo-list');
    const empty = document.getElementById('empty-state');
    list.innerHTML = '';

    if (!todos.length) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    const catIcons = {
      work: '💼', personal: '👤', health: '🏃', finance: '💰',
      household: '🏠', social: '👥', learning: '📚', errands: '🛒', general: '📝'
    };
    const priLabels = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low', 5: 'Someday' };

    todos.forEach(t => {
      const card = document.createElement('div');
      card.className = `todo-card${t.status === 'done' ? ' done' : ''}`;
      card.dataset.priority = t.priority;
      card.onclick = () => this.showModal(t);

      const checkDiv = document.createElement('div');
      checkDiv.className = `todo-check${t.status === 'done' ? ' checked' : ''}`;
      checkDiv.onclick = e => { e.stopPropagation(); this.toggleDone(t); };

      const body = document.createElement('div');
      body.className = 'todo-body';

      const text = document.createElement('div');
      text.className = 'todo-text';
      text.textContent = t.text;

      const meta = document.createElement('div');
      meta.className = 'todo-meta';

      // Priority chip: show "pending" if priority is null (not yet processed)
      const priChip = document.createElement('span');
      if (t.priority == null) {
        priChip.className = 'chip priority-pending';
        priChip.textContent = '⏳ pending';
      } else {
        priChip.className = `chip priority-${t.priority}`;
        priChip.textContent = priLabels[t.priority] || 'Unknown';
      }
      meta.appendChild(priChip);

      if (t.category && t.category !== 'general') {
        const catChip = document.createElement('span');
        catChip.className = 'chip';
        catChip.textContent = `${catIcons[t.category] || ''} ${t.category}`;
        meta.appendChild(catChip);
      }
      if (t.due_date) {
        const dueChip = document.createElement('span');
        dueChip.className = 'chip';
        dueChip.textContent = `📅 ${t.due_date}`;
        meta.appendChild(dueChip);
      }
      if (t.scheduled_time) {
        const schedChip = document.createElement('span');
        schedChip.className = 'chip';
        schedChip.textContent = `⏰ ${t.scheduled_time.slice(11, 16)}`;
        meta.appendChild(schedChip);
      }

      body.appendChild(text);
      body.appendChild(meta);

      if (t.notes) {
        const notes = document.createElement('div');
        notes.className = 'todo-notes';
        notes.textContent = t.notes;
        body.appendChild(notes);
      }

      card.appendChild(checkDiv);
      card.appendChild(body);
      list.appendChild(card);
    });
  },

  async toggleDone(todo) {
    if (!this.online) { this.toast('Not connected'); return; }
    const newStatus = todo.status === 'done' ? 'pending' : 'done';
    const update = newStatus === 'done'
      ? { status: 'done', completed_at: new Date().toISOString() }
      : { status: 'pending', completed_at: null };
    await db.from('todos').update(update).eq('id', todo.id);
    this.loadTodos();
  },

  // ── Modal ─────────────────────────────────────────────────────────────────────
  showModal(todo) {
    this.currentTodoId = todo.id;
    this.currentTodo = todo;
    this.calendarLink = null;

    document.getElementById('modal-task-text').textContent = todo.text;
    const fields = document.getElementById('modal-fields');
    const priLabels = { 1: '🔴 Urgent', 2: '🟠 High', 3: '🟡 Medium', 4: '🟢 Low', 5: '⚪ Someday' };
    const priDisplay = todo.priority != null ? (priLabels[todo.priority] || todo.priority) : '⏳ Pending (unprocessed)';

    fields.innerHTML = `
      <div class="modal-field"><label>Priority</label><span>${priDisplay}</span></div>
      <div class="modal-field"><label>Category</label><span>${todo.category || 'unset'}</span></div>
      ${todo.due_date ? `<div class="modal-field"><label>Due</label><span>${todo.due_date}</span></div>` : ''}
      ${todo.scheduled_time ? `<div class="modal-field"><label>Time</label><span>${todo.scheduled_time}</span></div>` : ''}
      ${todo.notes ? `<div class="modal-field"><label>Note</label><span style="color:var(--text-muted);font-style:italic">${todo.notes}</span></div>` : ''}
      <div class="modal-field"><label>Added</label><span>${(todo.created_at || '').slice(0, 10)}</span></div>
    `;

    document.getElementById('modal-overlay').classList.remove('hidden');

    // Build calendar link if due_date present
    if (todo.due_date) {
      this.calendarLink = this._buildCalendarLink(todo);
    }
  },

  closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    this.currentTodoId = null;
    this.currentTodo = null;
  },

  async completeTodo() {
    if (!this.currentTodoId) return;
    if (!this.online) { this.toast('Not connected'); return; }
    const { error } = await db.from('todos')
      .update({ status: 'done', completed_at: new Date().toISOString() })
      .eq('id', this.currentTodoId);
    if (error) { this.toast('Error updating task'); return; }
    this.closeModal();
    this.loadTodos();
    this.toast('Task done!');
  },

  async deleteTodo() {
    if (!this.currentTodoId) return;
    if (!this.online) { this.toast('Not connected'); return; }
    if (!confirm('Delete this task?')) return;
    const { error } = await db.from('todos')
      .update({ status: 'deleted', deleted_at: new Date().toISOString() })
      .eq('id', this.currentTodoId);
    if (error) { this.toast('Error deleting task'); return; }
    this.closeModal();
    this.loadTodos();
    this.toast('Deleted');
  },

  openCalendar() {
    if (this.calendarLink) window.open(this.calendarLink, '_blank');
    else this.toast('No date set for this task');
  },

  _buildCalendarLink(todo) {
    if (!todo.due_date) return null;
    const base = 'https://calendar.google.com/calendar/render?action=TEMPLATE';
    const title = encodeURIComponent(todo.text);
    const date = todo.due_date.replace(/-/g, '');
    // All-day event
    const dates = `${date}/${date}`;
    let link = `${base}&text=${title}&dates=${dates}`;
    if (todo.notes) link += `&details=${encodeURIComponent(todo.notes)}`;
    return link;
  },

  // ── Voice recording ───────────────────────────────────────────────────────────
  setupSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      document.getElementById('record-hint').textContent = 'Voice not supported — use text input below';
      return;
    }
    this.recognition = new SR();
    this.recognition.continuous = false;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.recognition.onresult = e => {
      let interim = '', final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      const combined = (this.transcript + ' ' + final).trim();
      // Deduplicate: remove repeated first word that Android sometimes fires twice
      const deduped = combined.replace(/^(\S+)\s+\1\b/i, '$1');
      this.transcript = deduped || interim;
      document.getElementById('transcript-text').textContent = this.transcript || interim;
      if (this.transcript) this.showTranscript();
    };

    this.recognition.onend = () => {
      this.recording = false;
      document.getElementById('mic-btn').classList.remove('recording');
      document.getElementById('record-hint').textContent = 'Tap to speak your task';
      if (this.transcript) this.showTranscript();
    };

    this.recognition.onerror = e => {
      this.recording = false;
      document.getElementById('mic-btn').classList.remove('recording');
      this.toast(`Mic error: ${e.error}`);
    };
  },

  toggleRecording() {
    if (!this.recognition) { this.toast('Voice not available on this browser'); return; }
    if (this.recording) {
      this.recognition.stop();
    } else {
      this.transcript = '';
      document.getElementById('transcript-box').classList.add('hidden');
      this.recognition.start();
      this.recording = true;
      document.getElementById('mic-btn').classList.add('recording');
      document.getElementById('record-hint').textContent = 'Listening… tap again to stop';
    }
  },

  showTranscript() {
    const box = document.getElementById('transcript-box');
    box.classList.remove('hidden');
    document.getElementById('transcript-text').textContent = this.transcript;
  },

  clearTranscript() {
    this.transcript = '';
    document.getElementById('transcript-box').classList.add('hidden');
    document.getElementById('record-hint').textContent = 'Tap to speak your task';
  },

  async submitTranscript() {
    if (!this.transcript.trim()) return;
    await this.addTodo(this.transcript.trim());
    this.clearTranscript();
  },

  async submitManual() {
    const input = document.getElementById('manual-text');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await this.addTodo(text);
  },

  // ── Add todo ──────────────────────────────────────────────────────────────────
  async addTodo(text) {
    if (!this.online) {
      enqueue(text);
      this.checkSyncBanner();
      this.toast('Saved offline');
      return;
    }
    try {
      const { error } = await db.from('todos').insert({ text }).select().single();
      if (error) throw error;
      this.toast('Task added — Claude will prioritise it at noon');
      await this.loadTodos();
    } catch (e) {
      console.error('addTodo error:', e);
      enqueue(text);
      this.checkSyncBanner();
      this.toast('Saved offline');
    }
  },

  // ── Sync offline queue ────────────────────────────────────────────────────────
  async syncQueue() {
    const q = loadQueue();
    if (!q.length || !this.online) return;

    const dot = document.getElementById('status-dot');
    dot.className = 'status-dot syncing';

    let success = 0;
    const remaining = [];
    for (const item of q) {
      try {
        const { error } = await db.from('todos').insert({ text: item.text });
        if (error) throw error;
        success++;
      } catch { remaining.push(item); }
    }

    saveQueue(remaining);
    dot.className = `status-dot ${this.online ? 'online' : 'offline'}`;
    if (success) {
      this.toast(`Synced ${success} offline task(s)`);
      await this.loadTodos();
    }
    this.checkSyncBanner();
  },

  checkSyncBanner() {
    const q = loadQueue();
    const banner = document.getElementById('sync-banner');
    const count = document.getElementById('sync-count');
    if (q.length) {
      banner.classList.remove('hidden');
      count.textContent = q.length;
    } else {
      banner.classList.add('hidden');
    }
  },

  // ── Digest ────────────────────────────────────────────────────────────────────
  async loadDigest() {
    const content = document.getElementById('digest-content');
    content.innerHTML = '<p class="muted">Loading digest…</p>';

    if (!this.online) {
      content.innerHTML = '<p class="muted">Available when connected</p>';
      return;
    }

    try {
      const { data, error } = await db
        .from('digests')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error || !data) {
        content.innerHTML = '<p class="muted">No digest yet — arrives at 7am on weekdays</p>';
        return;
      }

      const dateStr = new Date(data.created_at).toLocaleDateString('en-GB', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      content.innerHTML = `<p style="color:var(--text-muted);font-size:0.8rem;margin-bottom:10px">${dateStr}</p>${escapeHtml(data.content)}`;
    } catch (e) {
      console.error('loadDigest error:', e);
      content.innerHTML = '<p class="muted">Failed to load digest</p>';
    }
  },

  // ── Toast ──────────────────────────────────────────────────────────────────────
  toast(msg, duration = 2500) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    el.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), duration);
  }
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}

document.addEventListener('DOMContentLoaded', () => app.init());
