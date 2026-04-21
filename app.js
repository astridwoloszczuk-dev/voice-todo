// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL  = 'https://mezayharkjyvnnhvdlww.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lemF5aGFya2p5dm5uaHZkbHd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTE2ODQsImV4cCI6MjA5MTY2NzY4NH0.GlyIlgobMa0lVjEhH59-Zu1mt3f_usAipFNsg0bJSqE';

const MEMBERS = ['Astrid', 'Niko', 'Max', 'Alex', 'Vicky'];
const COLORS  = { Astrid: '#d97706', Niko: '#dc2626', Max: '#16a34a', Alex: '#2563eb', Vicky: '#db2777' };
const INITIALS = { Astrid: 'As', Niko: 'N', Max: 'M', Alex: 'Al', Vicky: 'V' };

// ── Supabase ─────────────────────────────────────────────────────────────────
const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON);

// ── State ────────────────────────────────────────────────────────────────────
let currentUser = localStorage.getItem('todos_user') || null;
let currentTab  = localStorage.getItem('todos_tab')  || MEMBERS[0];
let addTarget   = currentTab;
let expandedId  = null;
let items       = new Map();

// ── DOM refs ─────────────────────────────────────────────────────────────────
const listEl      = document.getElementById('item-list');
const inputEl     = document.getElementById('item-input');
const addBtn      = document.getElementById('add-btn');
const micBtn      = document.getElementById('mic-btn');
const userBadge   = document.getElementById('user-badge');
const emptyState  = document.getElementById('empty-state');
const userModal   = document.getElementById('user-modal');
const userNameEl  = document.getElementById('user-name-input');
const userSaveBtn = document.getElementById('user-save-btn');
const tabBar      = document.getElementById('tab-bar');
const modalNames  = document.getElementById('modal-names');

// ── Build tab bar + modal names ───────────────────────────────────────────────
MEMBERS.forEach(name => {
  // Tab button
  const btn = document.createElement('button');
  btn.className = 'tab-btn';
  btn.dataset.member = name;
  btn.innerHTML = `<span class="tab-initial" style="background:${COLORS[name]}">${INITIALS[name]}</span><span>${name}</span>`;
  btn.addEventListener('click', () => setTab(name));
  tabBar.appendChild(btn);

  // Modal name button
  const mb = document.createElement('button');
  mb.className = 'modal-name-btn';
  mb.textContent = name;
  mb.addEventListener('click', () => {
    userNameEl.value = name;
    userSaveBtn.click();
  });
  modalNames.appendChild(mb);
});


// ── User setup ────────────────────────────────────────────────────────────────
function showUserModal() { userModal.classList.remove('hidden'); userNameEl.focus(); }
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
  addTarget  = name;
  localStorage.setItem('todos_tab', name);
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.member === name)
  );
  expandedId = null;
  renderList();
}

// ── Time formatting ──────────────────────────────────────────────────────────
function timeAgo(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderList() {
  listEl.innerHTML = '';

  const tabItems = [...items.values()].filter(i =>
    i.owner === currentTab && i.status !== 'done' && i.status !== 'deleted'
  );

  const pendingAccept = tabItems.filter(i =>
    i.assignment_status === 'pending' && i.added_by_name && i.added_by_name !== currentTab
  );
  const normal = tabItems
    .filter(i => !(i.assignment_status === 'pending' && i.added_by_name && i.added_by_name !== currentTab))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));

  const high   = normal.filter(i => i.priority >= 7);
  const medium = normal.filter(i => i.priority >= 4 && i.priority < 7);
  const low    = normal.filter(i => i.priority >= 1 && i.priority < 4);
  const unprio = normal.filter(i => !i.priority)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const waiting = [...items.values()].filter(i =>
    i.added_by_name === currentTab &&
    i.owner !== currentTab &&
    i.assignment_status === 'pending' &&
    i.status !== 'done' && i.status !== 'deleted'
  );

  if (high.length)           renderSection('High priority', high, 'high');
  if (medium.length)         renderSection('Medium priority', medium, 'medium');
  if (low.length)            renderSection('Low priority', low, 'low');
  if (unprio.length)         renderSection('Not yet prioritised', unprio, 'unprio');
  if (pendingAccept.length)  renderSection('Needs your acceptance', pendingAccept, 'pending-accept');
  if (waiting.length)        renderSection('Waiting for acceptance', waiting, 'waiting');

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
  const isWaiting       = cls === 'waiting';
  const isPendingAccept = cls === 'pending-accept';
  const isExpanded      = String(item.id) === String(expandedId);

  const currentPrioBand = item.priority >= 7 ? 'high' : item.priority >= 4 ? 'medium' : item.priority >= 1 ? 'low' : null;

  // Move-to pills
  const movePills = MEMBERS.map(name => {
    const isCurrent = name === item.owner;
    return `<button class="move-pill${isCurrent ? ' current' : ''}" style="background:${COLORS[name]};color:white" data-move="${item.id}" data-to="${name}">${INITIALS[name]}</button>`;
  }).join('');

  // Priority buttons
  const prioBtns = [
    { label: 'High', cls: 'high-p', val: 9 },
    { label: 'Medium', cls: 'medium-p', val: 6 },
    { label: 'Low', cls: 'low-p', val: 3 },
    { label: 'Clear', cls: 'clear-p', val: 0 },
  ].map(({ label, cls: pc, val }) => {
    const isActive = (pc === 'high-p' && currentPrioBand === 'high') ||
                     (pc === 'medium-p' && currentPrioBand === 'medium') ||
                     (pc === 'low-p' && currentPrioBand === 'low');
    return `<button class="prio-btn ${pc}${isActive ? ' active-p' : ''}" data-prio="${item.id}" data-val="${val}">${label}</button>`;
  }).join('');

  const wrap = document.createElement('li');
  wrap.id = `item-${item.id}`;
  wrap.className = 'item-wrap' + (isWaiting ? ' waiting' : '');
  wrap.innerHTML = `
    <div class="item-main" data-expand="${item.id}">
      <button class="check-btn" data-check="${item.id}" aria-label="Complete">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      </button>
      <div class="item-body">
        <span class="item-name">${escapeHtml(item.text)}</span>
        <span class="item-meta">${item.added_by_name ? escapeHtml(item.added_by_name) : ''}${isWaiting ? ` → ${escapeHtml(item.owner)}` : ''}${item.created_at ? ' · ' + timeAgo(item.created_at) : ''}${item.category ? ' · ' + escapeHtml(item.category) : ''}</span>
      </div>
      ${item.priority ? `<span class="badge prio">${item.priority}</span>` : '<span class="badge unprio">—</span>'}
      ${isPendingAccept ? `<button class="accept-btn" data-accept="${item.id}">Accept</button>` : ''}
      <button class="delete-btn" data-delete="${item.id}" aria-label="Delete">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="item-actions${isExpanded ? ' open' : ''}">
      <div class="action-section">
        <div class="action-label">Move to</div>
        <div class="action-pills">${movePills}</div>
      </div>
      <div class="action-section">
        <div class="action-label">Priority</div>
        <div class="prio-btns">${prioBtns}</div>
      </div>
    </div>
  `;
  listEl.appendChild(wrap);
}

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadItems() {
  const { data, error } = await db
    .from('todos').select('*')
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
    items.set(item.id, item); renderList();
  })
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'todos' }, ({ new: item }) => {
    if (item.status === 'deleted') { items.delete(item.id); } else { items.set(item.id, item); }
    renderList();
  })
  .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'todos' }, ({ old: item }) => {
    items.delete(item.id); renderList();
  })
  .subscribe();

// ── Add item ──────────────────────────────────────────────────────────────────
async function addItem() {
  if (!currentUser) { showUserModal(); return; }
  const text = inputEl.value.trim();
  if (!text) return;
  const isSelf = addTarget === currentUser;
  inputEl.value = '';
  inputEl.focus();
  const { error } = await db.from('todos').insert({
    text, owner: addTarget, added_by_name: currentUser,
    status: 'pending', assignment_status: isSelf ? null : 'pending',
  });
  if (error) { console.error(error); inputEl.value = text; }
}

addBtn.addEventListener('click', addItem);
inputEl.addEventListener('keydown', e => e.key === 'Enter' && addItem());

// ── List interactions ─────────────────────────────────────────────────────────
listEl.addEventListener('click', async e => {
  // Expand/collapse
  const expandTarget = e.target.closest('[data-expand]');
  if (expandTarget && !e.target.closest('button')) {
    const id = expandTarget.dataset.expand;
    expandedId = String(expandedId) === String(id) ? null : id;
    renderList();
    return;
  }

  // Complete
  const checkBtn = e.target.closest('[data-check]');
  if (checkBtn) {
    await db.from('todos').update({ status: 'done', completed_at: new Date().toISOString() })
      .eq('id', checkBtn.dataset.check);
    return;
  }

  // Delete
  const deleteBtn = e.target.closest('[data-delete]');
  if (deleteBtn) {
    await db.from('todos').update({ status: 'deleted', deleted_at: new Date().toISOString() })
      .eq('id', deleteBtn.dataset.delete);
    return;
  }

  // Accept assignment
  const acceptBtn = e.target.closest('[data-accept]');
  if (acceptBtn) {
    await db.from('todos').update({ assignment_status: 'accepted' })
      .eq('id', acceptBtn.dataset.accept);
    return;
  }

  // Move to
  const moveBtn = e.target.closest('[data-move]');
  if (moveBtn) {
    await db.from('todos').update({
      owner: moveBtn.dataset.to,
      assignment_status: moveBtn.dataset.to === currentUser ? null : 'pending',
    }).eq('id', moveBtn.dataset.move);
    expandedId = null;
    return;
  }

  // Change priority
  const prioBtn = e.target.closest('[data-prio]');
  if (prioBtn) {
    const val = parseInt(prioBtn.dataset.val);
    await db.from('todos').update({ priority: val || null })
      .eq('id', prioBtn.dataset.prio);
    expandedId = null;
    return;
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

  micBtn.addEventListener('click', () => { if (listening) recognition.stop(); else recognition.start(); });
  recognition.addEventListener('start', () => { listening = true; micBtn.classList.add('listening'); inputEl.placeholder = 'Listening…'; });
  recognition.addEventListener('result', e => {
    inputEl.value = Array.from(e.results).map(r => r[0].transcript).join('');
    if (e.results[e.results.length - 1].isFinal) { recognition.stop(); addItem(); }
  });
  recognition.addEventListener('end', () => { listening = false; micBtn.classList.remove('listening'); inputEl.placeholder = 'Add todo…'; });
  recognition.addEventListener('error', () => { listening = false; micBtn.classList.remove('listening'); inputEl.placeholder = 'Add todo…'; });
}

// ── Init ──────────────────────────────────────────────────────────────────────
if (!currentUser) { showUserModal(); } else { userBadge.textContent = currentUser; }
setTab(currentTab);
loadItems();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
