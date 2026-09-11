// Display names are cosmetic and local to a project. Routing, reservations and
// messaging always use the permanent ids (master, oc-1, oc-2 …), which never
// change, so renaming a pane can never break coordination.
//
// Double-click a pane's title to edit it; Enter saves and tells the master.

export function installTerminalNames(invoke) {
  const project = () => document.getElementById('project-path').value.trim().replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
  const key = () => `terminal-names:${project()}`;
  const saved = () => {
    try {
      const value = JSON.parse(localStorage.getItem(key()) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };
  const nameFor = (id, fallback) => {
    const name = saved()[id];
    return typeof name === 'string' && name.trim() ? name : fallback;
  };

  function store(id, name) {
    try {
      localStorage.setItem(key(), JSON.stringify({ ...saved(), [id]: name }));
      return true;
    } catch {
      return false; // A full or blocked store is a real failure; keep the old name.
    }
  }

  /** Turn the title into an input in place, and commit on Enter or blur. */
  function edit(title, card) {
    if (title.querySelector('input')) return;
    const id = card.dataset.id;
    const before = title.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'terminal-title-input';
    input.value = before;
    input.maxLength = 60;
    input.setAttribute('aria-label', `Display name for ${id}`);
    title.textContent = '';
    title.appendChild(input);
    input.focus();
    input.select();

    let settled = false;
    const finish = async (commit) => {
      if (settled) return;
      settled = true;
      const name = input.value.trim();
      title.textContent = before;
      if (!commit || !name || name === before) { refresh(); return; }
      if (!store(id, name)) { refresh(); return; }
      refresh();
      // The master coordinates by id, so tell it which id the new label belongs to.
      try {
        await invoke('notify_agents', {
          to: 'master',
          text: `Display name update: ${id} is now shown as "${name}". Ids are unchanged; keep addressing it as ${id}.`,
        });
      } catch { /* the rename still stands even if the note does not arrive */ }
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
      event.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('dblclick', (event) => event.stopPropagation());
  }

  const refresh = () => {
    document.querySelectorAll('.terminal-pane').forEach((card) => {
      const title = card.querySelector('.terminal-title');
      if (!title || title.querySelector('input')) return;
      if (!card.dataset.originalTitle) card.dataset.originalTitle = title.textContent;
      const name = nameFor(card.dataset.id, card.dataset.originalTitle);
      if (title.textContent !== name) title.textContent = name;
      // Write only on change: this runs from a MutationObserver on #app, and an
      // unconditional write retriggers the observer, looping forever and leaving
      // the page permanently unstable.
      const hint = `${name} · ${card.dataset.id} · double-click to rename`;
      if (title.getAttribute('title') !== hint) title.title = hint;
      if (!title.dataset.editable) {
        title.dataset.editable = 'true';
        title.classList.add('terminal-title-editable');
        title.addEventListener('dblclick', () => edit(title, card));
      }
      // The rename button is gone; drop any left over from a previous build.
      card.querySelector('.terminal-rename')?.remove();
    });
    document.querySelectorAll('#target-select option').forEach((option) => {
      if (!option.dataset.originalTitle) option.dataset.originalTitle = option.textContent;
      const name = nameFor(option.value, option.dataset.originalTitle);
      if (option.textContent !== name) option.textContent = name;
    });
  };

  new MutationObserver(refresh).observe(document.getElementById('app'), { childList: true, subtree: true });
  refresh();
}
