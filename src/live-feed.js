import './live-feed.css';

/**
 * Live Feed tab — chronological stream of Pi Messenger events.
 * Reads feed.jsonl (via Tauri read_feed) and registry (via read_registry).
 * Replaces the terminal workspace view when selected; master terminal stays visible.
 */

const EVENT_ICONS = {
  join: '🟢', leave: '🔴', message: '💬', reserve: '🔒', release: '🔓',
  commit: '📝', test: '🧪', edit: '✏️', stuck: '⚠️',
  'task.start': '▶️', 'task.done': '✅', 'task.review': '👀',
  'task.block': '🚫', 'task.unblock': '🔄', 'task.reset': '↩️',
  'task.delete': '🗑️', 'task.split': '✂️', 'task.revise': '📋',
  'task.approve': '👍', 'task.reject': '👎',
  'plan.start': '📊', 'plan.done': '🏁', 'plan.cancel': '❌', 'plan.failed': '💥',
};

function formatTimestamp(ts) {
  try {
    const date = new Date(ts);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch { return ts || ''; }
}

function eventTypeLabel(type) {
  if (!type) return 'unknown';
  return type.replace(/\./g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatPreview(text, maxLen = 120) {
  if (!text) return '';
  const clean = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > maxLen ? clean.slice(0, maxLen - 3) + '…' : clean;
}

function createEventRow(event) {
  const row = document.createElement('div');
  row.className = 'feed-event';
  const isTask = (event.type || '').startsWith('task.') || (event.type || '').startsWith('plan.');
  if (isTask) row.classList.add('feed-event-task');
  if (event.type === 'message') row.classList.add('feed-event-message');
  if (event.type === 'stuck') row.classList.add('feed-event-warning');

  const icon = EVENT_ICONS[event.type] || '📋';

  const time = document.createElement('span');
  time.className = 'feed-time';
  time.textContent = formatTimestamp(event.ts);

  const badge = document.createElement('span');
  badge.className = 'feed-badge';
  badge.textContent = icon;
  badge.title = eventTypeLabel(event.type);

  const agent = document.createElement('span');
  agent.className = 'feed-agent';
  agent.textContent = event.agent || 'unknown';

  const type = document.createElement('span');
  type.className = 'feed-type';
  type.textContent = eventTypeLabel(event.type);

  const details = document.createElement('span');
  details.className = 'feed-details';
  const parts = [];
  if (event.target) parts.push(`→ ${event.target}`);
  if (event.preview) parts.push(formatPreview(event.preview));
  details.textContent = parts.join(' — ');
  if (event.preview) details.title = event.preview;

  row.append(time, badge, agent, type, details);
  return row;
}

function createAgentStatusCard(reg) {
  const card = document.createElement('div');
  card.className = 'feed-agent-card';
  const activity = reg.activity?.currentActivity || 'unknown';
  card.classList.add(activity === 'working' ? 'feed-agent-working' : 'feed-agent-idle');

  const name = document.createElement('span');
  name.className = 'feed-agent-name';
  name.textContent = reg.name || 'unknown';

  const status = document.createElement('span');
  status.className = 'feed-agent-status';
  status.textContent = activity;

  const model = document.createElement('span');
  model.className = 'feed-agent-model';
  model.textContent = reg.model || '';

  card.append(name, status, model);
  return card;
}

export function installLiveFeed(invoke) {
  if (document.getElementById('live-feed-tab')) return;

  // --- Tab button in the context bar ---
  const contextBar = document.querySelector('.context-bar');
  const tab = document.createElement('button');
  tab.id = 'live-feed-tab';
  tab.className = 'btn';
  tab.type = 'button';
  tab.textContent = '📡 Live Feed';
  tab.title = 'View chronological activity feed from all Pi agents';
  contextBar.appendChild(tab);

  // --- Feed panel (replaces subagents column when active) ---
  const panel = document.createElement('div');
  panel.id = 'live-feed-panel';
  panel.className = 'live-feed-panel';
  panel.hidden = true;

  panel.innerHTML = `
    <div class="feed-toolbar">
      <h3 class="feed-title">📡 Live Activity Feed</h3>
      <div class="feed-controls">
        <select id="feed-filter" aria-label="Filter events">
          <option value="all">All events</option>
          <option value="message">Messages</option>
          <option value="task">Tasks</option>
          <option value="edit">Edits & commits</option>
          <option value="status">Join / leave</option>
        </select>
        <button class="btn" id="feed-refresh" type="button">↻ Refresh</button>
        <button class="btn" id="feed-back" type="button">← Back to terminals</button>
      </div>
    </div>
    <div class="feed-agents-bar" id="feed-agents-bar">
      <strong>Agents:</strong>
      <div id="feed-agents-list" class="feed-agents-list"></div>
    </div>
    <div class="feed-stream" id="feed-stream" role="log" aria-live="polite" aria-label="Activity feed">
      <div class="feed-empty">No activity recorded yet. Events will appear as agents work.</div>
    </div>
    <div class="feed-status" id="feed-status"></div>
  `;

  const workspace = document.querySelector('.workspace-container');
  workspace.parentNode.insertBefore(panel, workspace.nextSibling);

  // --- Elements ---
  const stream = panel.querySelector('#feed-stream');
  const agentsList = panel.querySelector('#feed-agents-list');
  const filter = panel.querySelector('#feed-filter');
  const statusBar = panel.querySelector('#feed-status');
  const refreshBtn = panel.querySelector('#feed-refresh');
  const backBtn = panel.querySelector('#feed-back');

  let active = false;
  let autoRefreshTimer = null;
  let lastEventCount = 0;

  function show() {
    active = true;
    workspace.hidden = true;
    panel.hidden = false;
    tab.classList.add('btn-primary');
    tab.textContent = '📡 Live Feed ●';
    loadFeed();
    autoRefreshTimer = setInterval(loadFeed, 3000);
  }

  function hide() {
    active = false;
    panel.hidden = true;
    workspace.hidden = false;
    tab.classList.remove('btn-primary');
    tab.textContent = '📡 Live Feed';
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    // Trigger terminal resize after showing
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  function matchesFilter(event) {
    const f = filter.value;
    if (f === 'all') return true;
    if (f === 'message') return event.type === 'message';
    if (f === 'task') return (event.type || '').startsWith('task.') || (event.type || '').startsWith('plan.');
    if (f === 'edit') return event.type === 'edit' || event.type === 'commit' || event.type === 'test';
    if (f === 'status') return event.type === 'join' || event.type === 'leave' || event.type === 'stuck';
    return true;
  }

  async function loadFeed() {
    try {
      // Load feed events and registry in parallel
      const [feedRaw, registryRaw] = await Promise.all([
        invoke('read_feed', { limit: 500 }),
        invoke('read_registry'),
      ]);

      const events = JSON.parse(feedRaw);
      const agents = JSON.parse(registryRaw);

      // Update agent status bar
      agentsList.replaceChildren();
      agents.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));
      for (const reg of agents) {
        agentsList.appendChild(createAgentStatusCard(reg));
      }

      // Update feed stream
      const filtered = events.filter(matchesFilter);

      // Only update DOM if event count changed (avoid flicker)
      if (filtered.length !== lastEventCount || !stream.querySelector('.feed-event')) {
        lastEventCount = filtered.length;
        stream.replaceChildren();

        if (filtered.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'feed-empty';
          empty.textContent = filter.value === 'all'
            ? 'No activity recorded yet. Events will appear as agents work.'
            : `No ${filter.options[filter.selectedIndex].text.toLowerCase()} events found.`;
          stream.appendChild(empty);
        } else {
          // Show events oldest-first, scroll to bottom
          for (const event of filtered) {
            stream.appendChild(createEventRow(event));
          }
          stream.scrollTop = stream.scrollHeight;
        }
      }

      statusBar.textContent = `${events.length} events · ${agents.length} agents online · Updated ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      statusBar.textContent = `Feed unavailable: ${err?.message || err}`;
    }
  }

  // --- Event handlers ---
  tab.addEventListener('click', () => {
    if (active) hide(); else show();
  });
  backBtn.addEventListener('click', hide);
  refreshBtn.addEventListener('click', loadFeed);
  filter.addEventListener('change', () => { lastEventCount = -1; loadFeed(); });

  // Keyboard: Escape returns to terminals
  panel.addEventListener('keydown', e => {
    if (e.key === 'Escape') hide();
  });
}
