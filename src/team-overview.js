import './team-overview.css';

// Read-only snapshot: no transcripts, provider changes, or inferred usage totals.
export function installTeamOverview(invoke) {
  if (document.getElementById('team-overview-dialog')) return;
  const button = document.createElement('button');
  button.id = 'btn-team-overview';
  button.className = 'btn';
  button.type = 'button';
  button.textContent = 'Team overview';
  button.setAttribute('aria-haspopup', 'dialog');
  (document.querySelector('.context-bar') || document.getElementById('app') || document.body).appendChild(button);

  const dialog = document.createElement('dialog');
  dialog.id = 'team-overview-dialog';
  dialog.setAttribute('aria-labelledby', 'team-overview-title');
  dialog.innerHTML = `
    <header class="team-overview-header"><h2 id="team-overview-title">Team overview</h2><button class="btn" id="team-overview-close" type="button">Close</button></header>
    <p class="team-overview-intro">Current assignments and board state. Refresh to retrieve the latest snapshot.</p>
    <section class="team-overview-usage" aria-label="Usage"><strong>Tokens: <span id="team-overview-tokens">Unavailable</span></strong><strong>Cost: <span id="team-overview-cost">Unavailable</span></strong><p id="team-overview-usage-note"></p></section>
    <p id="team-overview-status" role="status" aria-live="polite"></p>
    <section id="team-overview-agents" aria-label="Agents"></section>
    <section aria-label="Task board"><h3 class="team-overview-board-title">Task board</h3><div id="team-overview-board"></div></section>
    <footer class="team-overview-footer"><button class="btn" id="team-overview-refresh" type="button">Refresh</button></footer>`;
  document.body.appendChild(dialog);
  const status = dialog.querySelector('#team-overview-status');
  const agents = dialog.querySelector('#team-overview-agents');
  const refresh = dialog.querySelector('#team-overview-refresh');
  let busy = false;
  const display = value => {
    if (value === null || value === undefined || value === '') return 'Unavailable';
    if (Array.isArray(value)) return value.length ? value.map(display).join('\n') : 'None reported';
    if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${display(item)}`).join('\n');
    return String(value);
  };
  const field = (list, label, value) => {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = display(value);
    list.append(term, detail);
  };
  async function load() {
    if (busy) return;
    busy = true;
    refresh.disabled = true;
    status.textContent = 'Loading team status…';
    try {
      const raw = await invoke('team_overview');
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!data || !Array.isArray(data.agents)) throw new Error('Team overview is unavailable. Open a workspace and try again.');
      agents.replaceChildren();
      for (const agent of data.agents) {
        const card = document.createElement('article');
        card.className = 'team-overview-agent';
        const heading = document.createElement('h3');
        const pane = [...document.querySelectorAll('.terminal-pane')].find(item => item.dataset.id === agent.id);
        heading.textContent = pane?.querySelector('.terminal-title')?.textContent || display(agent.id);
        const list = document.createElement('dl');
        field(list, 'Role', agent.role);
        field(list, 'Status', agent.status);
        field(list, 'Held file claims', agent.claims);
        field(list, 'Last recorded model', agent.model);
        field(list, 'Scope / task', agent.task);
        card.append(heading, list);
        agents.appendChild(card);
      }
      const board = Array.isArray(data.board?.slices) ? data.board.slices : [];
      const boardBox = dialog.querySelector('#team-overview-board');
      boardBox.replaceChildren();
      if (board.length) {
        for (const slice of board) {
          const row = document.createElement('div');
          row.className = `team-overview-slice slice-${String(slice.state || 'open').toLowerCase()}`;
          row.textContent = `${slice.id} · ${slice.title || ''} — ${slice.state}${slice.owner ? ` (owner ${slice.owner})` : ''}${slice.reviewer ? ` · reviewer ${slice.reviewer}` : ''} · ${slice.messageCount ?? 0} message(s)`;
          boardBox.appendChild(row);
        }
      } else {
        const empty = document.createElement('p');
        empty.textContent = 'No slices on the board yet.';
        boardBox.appendChild(empty);
      }
      const usage = data.usage || {};
      dialog.querySelector('#team-overview-tokens').textContent = Number.isFinite(usage.tokens) && usage.tokens >= 0 ? usage.tokens.toLocaleString() : 'Unavailable';
      dialog.querySelector('#team-overview-cost').textContent = Number.isFinite(usage.cost) && usage.cost >= 0 && usage.currency ? `${usage.cost} ${usage.currency}` : 'Unavailable';
      dialog.querySelector('#team-overview-usage-note').textContent = usage.note || 'The agent CLIs have not reported token or cost totals. No estimates are shown.';
      status.textContent = data.agents.length ? `Updated ${new Date().toLocaleTimeString()}` : 'No agents reported. Open a workspace to start the team.';
    } catch (error) {
      status.textContent = `${error?.message || String(error)}${agents.childElementCount ? ' Previous snapshot remains below.' : ''}`;
    } finally {
      busy = false;
      refresh.disabled = false;
    }
  }
  button.onclick = () => { dialog.showModal(); load(); };
  refresh.onclick = load;
  dialog.querySelector('#team-overview-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => button.focus());
}
