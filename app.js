// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL  = 'https://mezayharkjyvnnhvdlww.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lemF5aGFya2p5dm5uaHZkbHd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTE2ODQsImV4cCI6MjA5MTY2NzY4NH0.GlyIlgobMa0lVjEhH59-Zu1mt3f_usAipFNsg0bJSqE';

const MEMBERS = ['Astrid', 'Niko', 'Max', 'Alex', 'Vicky'];

// ── Supabase ─────────────────────────────────────────────────────────────────
const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON);

// ── State ────────────────────────────────────────────────────────────────────
let currentUser = localStorage.getItem('todos_user') || null;
let currentTab  = localStorage.getItem('todos_tab')  || MEMBERS[0];
let items = new Map(); // id → item

// ── DOM refs ─────────────────────────────────────────────────────────────────
const listEl      = document.getElementById('item-list');
const inputEl     = document.getElementById('item-input');
const addBtn      = document.getElementById('add-btn');
const micBtn      = document.getElementById('mic-btn');
const userBadge   = document.getElementById('user-badge');
const assignSel   = document.getElementById('assign-select');
const emptyState  = document.getElementById('empty-state');
const userModal   = document.getElementById('user-modal');
const userNameEl  = document.getElementById('user-name-input');
const userSaveBtn = document.getElementById('user-save-btn');
const tabBtns     = document.querySelectorAll('.tab-btn');

// ── User setup ────────────────────────────────────────────────────────────────
function showUserModal() {
  userModal.classList.remove('hidden');
  userNameEl.focus();
}
function saveUser() {
  const val = userNameEl.value.trim();
  if (!val) return;
  currentUser = val;
  localStorage.setItem('todos_user', val);
  userModal.classList.add('hidden');
  userBadge.textContent = val;
}
userSaveBtn.addEventListener('click', saveUser);
userNameEl.addEventListener('keydown', e => e.key === 'Enter' && saveUser());
userBadge.addEventListener('click', () => { userNameEl.value = currentUser || ''; showUserModal(); });

// ── Tabs ──────────────────────────────────────────────────────────────────────
function setTab(name) {
  currentTab = name;
  localStorage.setItem('todos_tab', name);
  tabBtns.forEach(b => b.classList.toggle('active', b.dataset.member === name));
  assignSel.value = name;
  renderList();
}
tabBtns.forEach(b => b.addEventListener('click', () => setTab(b.dataset.member)));

// ── Time formatting ──────────────────────────────────────────────────────────
function timeAgo(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderList() {
  listEl.innerHTML = '';

  const tabItems = [...items.values()].filter(i =>
    i.owner === currentTab && i.status !== 'done' && i.status !== 'deleted'
  );

  // Todos assigned TO this tab by someone else, pending acceptance
  const pendingAccept = tabItems.filter(i =>
    i.assignment_status === 'pending' && i.added_by_name && i.added_by_name !== currentTab
  );

  // Normal todos (self-added or already accepted)
  const normal = tabItems.filter(i =>
    !(i.assignment_status === 'pending' && i.added_by_name && i.added_by_name !== currentTab)
  );

  // Sort normal: prioritised first (desc), then unprioritised (newest first)
  const prioritised   = normal.filter(i => i.priority).sort((a, b) => b.priority - a.priority);
  const unprioritised = normal.filter(i => !i.priority).sort((a, b) =>
    new Date(b.created_at) - new Date(a.created_at)
  );

  // Todos assigned BY currentTab TO others, still pending
  const waiting = [...items.values()].filter(i =>
    i.added_by_name === currentTab &&
    i.owner !== currentTab &&
    i.assignment_status === 'pending' &&
    i.status !== 'done' && i.status !== 'deleted'
  );

  if (pendingAccept.length) renderSection('Needs your acceptance', pendingAccept, 'pending-accept');
  [...prioritised, ...unprioritised].forEach(i => renderItem(i));
  if (waiting.length) renderSection('Waiting for acceptance', waiting, 'waiting');

  emptyState.classList.toggle('hidden', tabItems.length > 0 || waiting.length > 0);
}

function renderSection(title, itemList, cls) {
  const header = document.createElement('li');
  header.className = `section-header ${cls}`;
  header.textContent = title;
  listEl.appendChild(header);
  itemList.forEach(i => renderItem(i, cls));
}

function renderItem(item, cls = '') {
  const li = document.createElement('li');
  li.id = `item-${item.id}`;
  li.className = 'item' + (cls ? ` ${cls}` : '');

  const isPendingAccept = cls === 'pending-accept';
  const isWaiting       = cls === 'waiting';

  li.innerHTML = `
    <button class="check-btn" data-id="${item.id}" aria-label="Complete">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
    </button>
    <div class="item-body">
      <span class="item-name">${escapeHtml(item.text)}</span>
      <span class="item-meta">
        ${item.added_by_name ? escapeHtml(item.added_by_name) : ''}${isWaiting ? ` → ${escapeHtml(item.owner)}` : ''}${item.created_at ? ' · ' + timeAgo(item.created_at) : ''}${item.category ? ' · ' + escapeHtml(item.category) : ''}
      </span>
    </div>
    ${item.priority ? `<span class="badge prio">${item.priority}</span>` : '<span class="badge unprio">—</span>'}
    ${isPendingAccept ? `<button class="accept-btn" data-id="${item.id}">Accept</button>` : ''}
    <button class="delete-btn" data-id="${item.id}" aria-label="Delete">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;
  listEl.appendChild(li);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadItems() {
  const { data, error } = await db
    .from('todos')
    .select('*')
    .not('status', 'eq', 'deleted')
    .order('created_at', { ascending: false });

  if (error) { console.error(error); return; }
  items.clear();
  data.forEach(i => items.set(i.id, i));
  renderList();
}

// ── Real-time ─────────────────────────────────────────────────────────────────
db.channel('todos-realtime')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'todos' }, ({ new: item }) => {
    items.set(item.id, item);
    renderList();
  })
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'todos' }, ({ new: item }) => {
    if (item.status === 'deleted') {
      items.delete(item.id);
    } else {
      items.set(item.id, item);
    }
    renderList();
  })
  .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'todos' }, ({ old: item }) => {
    items.delete(item.id);
    renderList();
  })
  .subscribe();

// ── Add item ──────────────────────────────────────────────────────────────────
async function addItem() {
  if (!currentUser) { showUserModal(); return; }
  const text = inputEl.value.trim();
  if (!text) return;
  const owner  = assignSel.value;
  const isSelf = owner === currentUser;

  inputEl.value = '';
  inputEl.focus();

  const { error } = await db.from('todos').insert({
    text,
    owner,
    added_by_name: currentUser,
    status: 'pending',
    assignment_status: isSelf ? null : 'pending',
  });
  if (error) { console.error(error); inputEl.value = text; }
}

addBtn.addEventListener('click', addItem);
inputEl.addEventListener('keydown', e => e.key === 'Enter' && addItem());

// ── List interactions ─────────────────────────────────────────────────────────
listEl.addEventListener('click', async e => {
  const checkBtn  = e.target.closest('.check-btn');
  const deleteBtn = e.target.closest('.delete-btn');
  const acceptBtn = e.target.closest('.accept-btn');

  if (checkBtn) {
    await db.from('todos').update({
      status: 'done',
      completed_at: new Date().toISOString(),
    }).eq('id', checkBtn.dataset.id);
  }

  if (deleteBtn) {
    await db.from('todos').update({
      status: 'deleted',
      deleted_at: new Date().toISOString(),
    }).eq('id', deleteBtn.dataset.id);
  }

  if (acceptBtn) {
    await db.from('todos').update({ assignment_status: 'accepted' })
      .eq('id', acceptBtn.dataset.id);
  }
});

// ── Voice input ───────────────────────────────────────────────────────────────
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognition) {
  micBtn.style.display = 'none';
} else {
  const recognition = new SpeechRecognition();
  recognition.lang = 'de-AT';
  recognition.interimResults = true;

  let listening = false;

  micBtn.addEventListener('click', () => {
    if (listening) { recognition.stop(); return; }
    recognition.start();
  });

  recognition.addEventListener('start', () => {
    listening = true;
    micBtn.classList.add('listening');
    inputEl.placeholder = 'Listening…';
  });

  recognition.addEventListener('result', e => {
    const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
    inputEl.value = transcript;
    if (e.results[e.results.length - 1].isFinal) {
      recognition.stop();
      addItem();
    }
  });

  recognition.addEventListener('end', () => {
    listening = false;
    micBtn.classList.remove('listening');
    inputEl.placeholder = 'Add todo…';
  });

  recognition.addEventListener('error', () => {
    listening = false;
    micBtn.classList.remove('listening');
    inputEl.placeholder = 'Add todo…';
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
if (!currentUser) {
  showUserModal();
} else {
  userBadge.textContent = currentUser;
}
setTab(currentTab);
loadItems();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}
