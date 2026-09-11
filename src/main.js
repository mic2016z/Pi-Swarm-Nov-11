import { installTeamOverview } from './team-overview.js';
import { installAgentDocuments } from './agent-documents.js';

import './agent-documents.css';

import { installTerminalNames } from './terminal-names.js';

import { installAgentTones, announceAgentStatus, forgetAgentStatuses } from './agent-tones.js';

import { installPaneModelPicker } from './pane-model.js';

import { installFolderPicker } from './folder-picker.js';

import './terminal-names.css';

import { invoke } from '@tauri-apps/api/core';

import { listen } from '@tauri-apps/api/event';

import { Terminal } from '@xterm/xterm';

import { FitAddon } from '@xterm/addon-fit';

import '@xterm/xterm/css/xterm.css';

import './style.css';



document.getElementById('app').innerHTML = `

<header class="top-bar"><div class="brand">Quad Squad <span>OC</span></div><div class="paths"><div class="path-row"><label for="project-path">Project</label><input id="project-path" type="text" placeholder="Select a project folder"><button class="btn icon" id="btn-browse" title="Browse for a project folder" aria-label="Browse for a project folder">📁</button></div><div class="path-row"><label for="repo-url">Repo</label><input id="repo-url" type="text" placeholder="owner/name or https://github.com/owner/name"><button class="btn icon" id="btn-save-repo" title="Save the repository and tell the agents" aria-label="Save repository">💾</button></div></div><div class="bar-actions"><button class="btn btn-primary" id="btn-start">Open workspace</button><button class="btn icon" id="btn-add-agent" disabled title="Add an agent" aria-label="Add an agent">+</button><button class="btn icon" id="btn-login" title="OpenCode sign in" aria-label="OpenCode sign in">🔑</button></div></header>

<div class="context-bar"><span id="workspace-label">One master and three agents.</span><button class="btn" id="btn-brief" disabled>Prepare master handover</button><button class="btn" id="btn-close">Close app</button></div>

<div class="error-bar hidden" id="error-bar" role="alert"><span id="error-message"></span><button id="btn-dismiss-error" class="btn-close" aria-label="Dismiss">×</button></div>

<div class="workspace-container"><section class="master-column" id="master-terminal-slot"><div class="empty-state"><strong>Your agents, in one place.</strong><p>Choose a project and open its workspace. One pane runs the master role; each pane keeps its own saved OpenCode session. Every pane launches with the same user-configured model.</p><small>Uses installed CLIs and their existing authentication.</small></div></section><section class="subagents-column"><div id="worker-tabs" role="tablist" aria-label="Agent workspaces"></div><div id="subagent-grid" class="worker-workspaces"></div></section></div>

<div id="brief-panel" hidden><label for="brief-text">Paste this into the master when its prompt is ready.</label><textarea id="brief-text" readonly></textarea><button class="btn" id="brief-hide">Hide handover</button></div>

<footer class="composer-bar"><select id="target-select" aria-label="Worker"></select><textarea id="composer-input" rows="2" placeholder="Delegate a task to a worker. Or type directly in any terminal."></textarea><button class="btn btn-primary" id="btn-send">Queue task →</button></footer>

<div class="footnote">Native interactive terminals · PowerShell on Windows · your shell on Linux/macOS. All panes launch with your configured OpenCode provider/model.</div>

<dialog id="close-dialog"><h2>Close workspace?</h2><p>Agents must finish active work first. Closing stops the master terminal; saved CLI history remains available.</p><div><button class="btn" id="close-cancel">Keep open</button><button class="btn btn-primary" id="close-confirm">Close workspace</button></div></dialog>`;



const state = {

  projectPath: '',

  terminals: new Map(), // id -> { terminal, fitAddon, container, descriptor }

  activeAgents: [],

  activeWorkspace: 0,

  starting: false,

  workspacePanels: new Map(),

};



const el = {

  projectInput: document.getElementById('project-path'),

  startBtn: document.getElementById('btn-start'),

  browseBtn: document.getElementById('btn-browse'),

  loginBtn: document.getElementById('btn-login'),

  addPiBtn: document.getElementById('btn-add-agent'),

  targetSelect: document.getElementById('target-select'),

  composerInput: document.getElementById('composer-input'),

  sendBtn: document.getElementById('btn-send'),

  errorBar: document.getElementById('error-bar'),

  errorMessage: document.getElementById('error-message'),

  dismissError: document.getElementById('btn-dismiss-error'),

  masterSlot: document.getElementById('master-terminal-slot'),

  subagentGrid: document.getElementById('subagent-grid'),

  workerTabs: document.getElementById('worker-tabs'),

};



function workspaceFor(id) {
  const number = Number(/^oc-(\d+)$/.exec(id)?.[1]);
  return number > 0 ? Math.floor((number - 1) / 4) : 0;
}

function selectWorkspace(index, focusTab = false) {
  state.activeWorkspace = index;
  for (const [number, { panel, tab }] of state.workspacePanels) {
    const active = number === index;
    panel.hidden = !active;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focusTab) tab.focus();
  }
  requestAnimationFrame(() => {
    for (const session of state.terminals.values()) session.syncSize();
  });
}

function ensureWorkspace(index) {
  if (state.workspacePanels.has(index)) return state.workspacePanels.get(index).panel;
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'btn worker-tab';
  tab.id = `worker-tab-${index + 1}`;
  tab.textContent = `Workspace ${index + 1}`;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', `worker-panel-${index + 1}`);
  const panel = document.createElement('section');
  panel.id = `worker-panel-${index + 1}`;
  panel.className = 'grid-2x2 worker-panel';
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', tab.id);
  panel.hidden = index !== state.activeWorkspace;
  tab.setAttribute('aria-selected', String(!panel.hidden));
  tab.tabIndex = panel.hidden ? -1 : 0;
  tab.onclick = () => selectWorkspace(index);
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const count = state.workspacePanels.size;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + count) % count;
    selectWorkspace(next, true);
  });
  state.workspacePanels.set(index, { panel, tab });
  el.workerTabs.appendChild(tab);
  el.subagentGrid.appendChild(panel);
  return panel;
}

function resetWorkspaces() {
  el.subagentGrid.replaceChildren();
  el.workerTabs.replaceChildren();
  state.workspacePanels.clear();
  state.activeWorkspace = 0;
  // Only the first workspace exists up front; more are added as panes arrive,
  // so a small squad shows one tab rather than five empty ones.
  ensureWorkspace(0);
}
resetWorkspaces();

const routeSelect = document.createElement('select');
const changeProject = document.createElement('button');
changeProject.className = 'btn icon';
changeProject.textContent = '🔄';
changeProject.title = 'Change project';
changeProject.setAttribute('aria-label', 'Change project');
changeProject.id = 'btn-change-project';
document.querySelector('.bar-actions').appendChild(changeProject);
// Kept as an alias for the folder button: one code path, one picker.
changeProject.addEventListener('click', () => el.browseBtn.click());

routeSelect.id = 'route-select';
routeSelect.setAttribute('aria-label', 'Task routing');
for (const [value, label] of [['delegate', 'Delegate to a worker'], ['master-only', 'Master-only'], ['master-review', 'Needs master review']]) routeSelect.add(new Option(label, value));
el.targetSelect.before(routeSelect);
routeSelect.addEventListener('change', () => {
  el.targetSelect.disabled = routeSelect.value !== 'delegate';
  el.composerInput.placeholder = routeSelect.value === 'delegate' ? 'Delegate a task to a worker.' : 'Send a task or work to review to the master.';
});

function showError(err) {

  const msg = err?.message || String(err);

  el.errorMessage.textContent = msg;

  el.errorBar.classList.remove('hidden');

}



function clearError() {

  el.errorBar.classList.add('hidden');

  el.errorMessage.textContent = '';

}



function updateTargetOptions() {

  const selected = el.targetSelect.value;
  el.targetSelect.innerHTML = '';
  const groups = new Map();

  state.activeAgents.filter(d => d.id.startsWith('oc-')).forEach((desc) => {

    const opt = document.createElement('option');

    opt.value = desc.id;

    opt.textContent = desc.title || desc.id;

    const workspace = workspaceFor(desc.id);
    if (!groups.has(workspace)) {
      const group = document.createElement('optgroup');
      group.label = `Workspace ${workspace + 1}`;
      groups.set(workspace, group);
      el.targetSelect.appendChild(group);
    }
    groups.get(workspace).appendChild(opt);

  });

  if ([...el.targetSelect.options].some(option => option.value === selected)) el.targetSelect.value = selected;
}



function createTerminalInstance(descriptor) {

  const { id, title } = descriptor;

  if (state.terminals.has(id)) return;

  const isMaster = id === 'master';



  const card = document.createElement('div');

  card.className = `terminal-pane ${isMaster ? 'master-pane' : 'subagent-pane'}`;

  card.dataset.id = id;



  const header = document.createElement('div');

  header.className = 'terminal-header';



  const titleSpan = document.createElement('span');

  titleSpan.className = 'terminal-title';

  titleSpan.textContent = title || id;



  const badge = document.createElement('span');

  badge.className = 'terminal-badge';

  badge.textContent = isMaster ? 'CLI MASTER' : id === 'auth' ? 'AUTH' : 'STARTING';



  header.appendChild(titleSpan);

  header.appendChild(badge);



  const termContainer = document.createElement('div');

  termContainer.className = 'xterm-wrapper';



  card.appendChild(header);

  card.appendChild(termContainer);



  if (isMaster) {

    // The master is the first cell of the shared grid, so a four-pane squad
    // reads as one 2x2 block with the master top left.
    el.masterSlot.innerHTML = '';
    const grid = ensureWorkspace(0);
    grid.prepend(card);

  } else {

    const workspace = workspaceFor(id);
    for (let index = 0; index <= workspace; index++) ensureWorkspace(index);
    card.dataset.workspace = String(workspace + 1);
    ensureWorkspace(workspace).appendChild(card);

  }



  const term = new Terminal({

    ...(navigator.userAgent.includes('Windows') ? { windowsPty: { backend: 'conpty', buildNumber: 22621 } } : {}),
    theme: {

      background: '#121417',

      foreground: '#e4e7eb',

      cursor: '#00f5a0',

      selectionBackground: '#26343f',

      black: '#121417',

      brightBlack: '#404752',

      green: '#00f5a0',

      brightGreen: '#45fbc0',

    },

    cursorBlink: true,

    fontSize: 12,

    fontFamily: 'JetBrains Mono, Consolas, monospace',

  });



  const fitAddon = new FitAddon();

  term.loadAddon(fitAddon);

  term.open(termContainer);



  const syncSize = () => {

    if (!termContainer.clientWidth || !termContainer.clientHeight || card.closest('[hidden]')) return;

    try {

      fitAddon.fit();

      if (term.rows && term.cols) {

        invoke('resize_terminal', { id, rows: term.rows, cols: term.cols }).catch(showError);

      }

    } catch (err) {

      showError(err);

    }

  };



  const resizeObserver = new ResizeObserver(() => syncSize());

  resizeObserver.observe(termContainer);

  setTimeout(syncSize, 50);



  // ConPTY requests Win32 INPUT_RECORD encoding (DECSET 9001).

  // Raw Unicode is enough for input(), but the native harness needs virtual key events.

  let win32Input = false;

  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => { if (params.includes(9001)) win32Input = true; return false; });

  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => { if (params.includes(9001)) win32Input = false; return false; });

  let inputChain = Promise.resolve();

  const send = data => { inputChain = inputChain.then(() => invoke('write_terminal', { id, data })).catch(showError); };

  const encodeKey = (vk, uc, down, modifiers = 0) => `\x1b[${vk};0;${uc};${down};${modifiers};1_`;

  term.attachCustomKeyEventHandler(event => {

    if (!win32Input || !['keydown', 'keyup'].includes(event.type)) return true;

    if (event.ctrlKey && event.shiftKey && ['KeyC', 'KeyV'].includes(event.code)) return true;

    let uc = event.key.length === 1 ? event.key.charCodeAt(0) : ({ Enter: 13, Tab: 9, Backspace: 8, Escape: 27 }[event.key] || 0);

    if (event.ctrlKey && /^[a-z]$/i.test(event.key)) uc = event.key.toUpperCase().charCodeAt(0) & 31;

    const modifiers = (event.shiftKey ? 16 : 0) | (event.ctrlKey ? 8 : 0) | (event.altKey ? 2 : 0);

    send(encodeKey(event.keyCode, uc, event.type === 'keydown' ? 1 : 0, modifiers));

    event.preventDefault();

    return false;

  });

  term.onData(data => {

    if (win32Input && (!data.startsWith('\x1b') || data.startsWith('\x1b[200~'))) {

      const text = data.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '');

      let encoded = '';

      for (let i = 0; i < text.length; i++) { const uc = text.charCodeAt(i); const vk = uc === 13 || uc === 10 ? 13 : 0; const char = uc === 10 ? 13 : uc; encoded += encodeKey(vk, char, 1) + encodeKey(vk, char, 0); }

      send(encoded);

    } else send(data);

  });



  state.terminals.set(id, {

    terminal: term,

    fitAddon,

    syncSize,

    container: card,

    descriptor,

    resizeObserver,

    badge,

  });

  if (descriptor.output) term.write(descriptor.output);



  if (!state.activeAgents.some((a) => a.id === id)) {

    state.activeAgents.push(descriptor);

    updateTargetOptions();

  }

}



async function initEventListeners() {

  await listen('terminal-output', (event) => {

    const { id, data } = event.payload || {};

    const session = state.terminals.get(id);

    if (session && data) {

      session.terminal.write(Array.isArray(data) ? new Uint8Array(data) : data);

    }

  });



  await listen('terminal-exit', (event) => {

    const { id, code } = event.payload || {};

    const session = state.terminals.get(id);

    if (session) {

      session.badge.textContent = 'EXITED';

      session.terminal.writeln(`\r\n\x1b[33m[Process exited with code ${code}]\x1b[0m`);

    }

  });

  await listen('terminal-restarted', event => { if (event.payload) createTerminalInstance(event.payload); });
  await listen('workspace-warning', e => showError(e.payload));

  await listen('close-request', closeApp);

}



// Choosing a folder is the whole gesture, so it opens the workspace too.
const folderPicker = installFolderPicker(invoke, (chosen) => {
  clearError();
  el.projectInput.value = chosen;
  el.startBtn.click();
});

el.browseBtn.addEventListener('click', () => {
  clearError();
  folderPicker.open(el.projectInput.value.trim());
});

el.startBtn.addEventListener('click', async () => {

  clearError();

  const project = el.projectInput.value.trim();

  if (!project) return showError('Project path cannot be empty.');

  el.startBtn.disabled = true;

  el.browseBtn.disabled = true;
  state.starting = true;
  changeProject.disabled = true;
  document.getElementById('btn-close').disabled = true;



  try {

    // Opening a different folder replaces the squad: close whatever is running so
    // every agent starts a fresh session rooted in the new project. State is keyed
    // by project path, so the new folder gets its own sessions and documents.
    const switching = state.activeAgents.length && state.projectPath && state.projectPath !== project;
    if (switching) {
      // The repository belongs to the old project; clear it now so a failed
      // switch cannot leave the squad pointed at the wrong repository.
      const repoBox = document.getElementById('repo-url');
      if (repoBox) repoBox.value = '';
      // Force: a deliberate switch must not be blocked by a busy agent. Failing
      // here used to abort silently and leave the old squad running.
      await invoke('close_workspace', { force: true });
      for (const session of state.terminals.values()) {
        session.resizeObserver.disconnect();
        session.terminal.dispose();
      }
      state.terminals.clear();
      state.activeAgents = [];
      el.masterSlot.innerHTML = '';
      resetWorkspaces();
      forgetAgentStatuses();
    }

    const descriptors = await invoke('start_workspace', { project });
    state.projectPath = project;

    el.masterSlot.innerHTML = '';

    resetWorkspaces();

    state.terminals.clear();

    state.activeAgents = [];



    descriptors.forEach((desc) => createTerminalInstance(desc));



    // Show the new project's own repository, or nothing when it has no remote.
    invoke('current_repo')
      .then((value) => { const box = document.getElementById('repo-url'); if (box) box.value = JSON.parse(value).github_repo || ''; })
      .catch(() => {});

    const snapshot = await invoke('snapshot');

    if (snapshot && Array.isArray(snapshot)) {

      snapshot.forEach((snap) => {

        const session = state.terminals.get(snap.id);

        if (session && snap.output) {

          session.terminal.reset(); session.terminal.write(snap.output);

        }

      });

    }

    el.projectInput.disabled = true;

    el.addPiBtn.disabled = false;

    document.getElementById('btn-brief').disabled = false;

    document.getElementById('workspace-label').textContent = project;
    await refreshRelayStatus();
  } catch (err) {

    showError(err);

    el.startBtn.disabled = false;

    el.browseBtn.disabled = false;

  } finally {
    state.starting = false;
    changeProject.disabled = false;
    // Re-enable in finally, not only on failure. A successful open used to leave
    // both disabled for good: the folder button could not be clicked again, and
    // because the picker triggers the switch through the start button, clicking
    // a disabled button fired nothing at all and the switch died silently.
    el.browseBtn.disabled = false;
    el.startBtn.disabled = false;
    document.getElementById('btn-close').disabled = false;
  }

});



el.loginBtn.addEventListener('click', async () => {

  clearError();

  try {

    createTerminalInstance(await invoke('login_pi'));

    const snapshots = await invoke('snapshot');

    const auth = snapshots.find(s => s.id === 'auth');

    if (auth) { const term = state.terminals.get('auth').terminal; term.reset(); term.write(auth.output); }

  } catch (err) {

    showError(err);

  }

});



el.addPiBtn.addEventListener('click', async () => {

  clearError();

  try {

    const descriptor = await invoke('add_agent');

    if (descriptor) {

      createTerminalInstance(descriptor);

    }

  } catch (err) {

    showError(err);

  }

});



el.sendBtn.addEventListener('click', async () => {

  clearError();

  const targetId = routeSelect.value === 'delegate' ? el.targetSelect.value : 'master';

  const prompt = el.composerInput.value.trim();

  if (!targetId) return showError('Select an agent target.');

  if (!prompt) return showError('Prompt cannot be empty.');



  try {

    el.sendBtn.disabled = true;
    const job = await invoke('submit_prompt', { id: targetId, prompt, route: routeSelect.value }).finally(() => { el.sendBtn.disabled = false; });

    document.getElementById('workspace-label').textContent = `Queued ${job} → ${targetId}`;

    el.composerInput.value = '';

  } catch (err) {

    showError(err);

  }

});



el.dismissError.addEventListener('click', clearError);



async function closeApp() {
  if (state.starting) return;

  document.getElementById('close-dialog').showModal();

}

document.getElementById('close-cancel').onclick = () => document.getElementById('close-dialog').close();

document.getElementById('close-confirm').onclick = async () => {

  document.getElementById('close-dialog').close();

  try { await invoke('shutdown'); } catch (err) { showError(err); }

};

document.getElementById('btn-close').onclick = closeApp;

document.getElementById('btn-brief').onclick = async () => {

  try { document.getElementById('brief-text').value = await invoke('master_brief'); document.getElementById('brief-panel').hidden = false; document.getElementById('brief-text').select(); } catch (err) { showError(err); }

};

document.getElementById('brief-hide').onclick = () => { document.getElementById('brief-panel').hidden = true; };

async function initialize() {
  el.startBtn.disabled = true;

  el.browseBtn.disabled = true;

  try {

    const directory = await invoke('launch_directory');

    if (!el.projectInput.value) el.projectInput.value = directory;

  } finally {

    el.startBtn.disabled = false;

    el.browseBtn.disabled = false;

  }

  await initEventListeners();
  el.startBtn.click();

  let refreshing = false;
  setInterval(async () => {
    if (!state.activeAgents.length) return;
    if (refreshing) return;
    refreshing = true;
    try { const status = JSON.parse(await invoke('workspace_status')); for (const [number, item] of Object.entries(status)) { const session = state.terminals.get('oc-' + number); if (session) session.badge.textContent = item.status.toUpperCase(); announceAgentStatus('oc-' + number, item.status); } await refreshRelayStatus(); } catch (_) { /* project not yet open */ }
    finally { refreshing = false; }
  }, 2500);
}
async function refreshRelayStatus() {
  try {
    const result = await invoke('relay_status');
    const master = state.terminals.get('master');
    if (master && master.badge.textContent !== 'EXITED') {
      master.badge.textContent = result.busy ? 'BUSY' : result.registered ? 'REGISTERED' : 'AWAITING REGISTRATION';
      announceAgentStatus('master', result.busy ? 'busy' : result.registered ? 'idle' : 'starting');
      master.badge.title = result.message;
    }
  } catch (error) {
    const master = state.terminals.get('master');
    if (master) master.badge.title = `Relay status unavailable: ${error}`;
  }
}
initialize().catch(showError);



installTerminalNames(invoke);
installAgentTones();
installPaneModelPicker(invoke);

// Shared repository: agents branch from it, the master merges into it.
(() => {
  const input = document.getElementById('repo-url');
  const save = document.getElementById('btn-save-repo');
  if (!input || !save) return;
  const show = (text, ok) => { save.textContent = text; save.classList.toggle('btn-primary', Boolean(ok)); };
  invoke('current_repo').then(value => { input.value = JSON.parse(value).github_repo || ''; }).catch(() => {});
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const result = JSON.parse(await invoke('set_repo', { repo: input.value.trim() }));
      input.value = result.github_repo || '';
      // Agents read the repository from their instructions, so a silent change
      // would leave them working against the previous one.
      const target = result.github_repo || '(none)';
      await invoke('notify_agents', { text: `The shared repository is now ${target}. Use it for any push, issue or review from here on.` }).catch(() => {});
      show('Saved', true);
    } catch (error) {
      // A rejected repository is a real answer; surface it instead of silently keeping the old value.
      showError(error);
      show('Retry', false);
    } finally {
      save.disabled = false;
      setTimeout(() => show('Save', false), 2000);
    }
  });
})();
// One bar only: move the essential control up and drop the rest of the chrome.
document.querySelector('.bar-actions')?.appendChild(document.getElementById('btn-close'));



installAgentDocuments(invoke);


installTeamOverview(invoke);

