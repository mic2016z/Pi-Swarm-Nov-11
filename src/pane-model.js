// Per-pane model picker.
//
// Each terminal gets its own burger. The menu lists providers; each provider
// opens a submenu of its models. Hermes has no external mid-session model
// switch, but its /model slash command changes the session model when typed
// into the pane, and the choice is remembered so a later relaunch of the pane
// starts on the same model.
//
// Providers and models come from models.json beside the executable, so the list
// can be edited without a rebuild, and from Hermes' own model catalog otherwise.

export function installPaneModelPicker(invoke) {
  const menu = document.createElement('div');
  menu.className = 'model-menu pane-model-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  document.body.appendChild(menu);

  const submenu = document.createElement('div');
  submenu.className = 'model-menu pane-model-submenu';
  submenu.hidden = true;
  submenu.setAttribute('role', 'menu');
  document.body.appendChild(submenu);

  let target = null;
  let providers = [];
  let configPath = '';
  let loadError = '';
  let source = '';

  function close() {
    menu.hidden = true;
    submenu.hidden = true;
    shownProvider = null;
    document.querySelectorAll('.pane-model-btn[aria-expanded="true"]')
      .forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }

  let loaded = false;

  async function load() {
    // Retry after a failure: the first attempt can run before a workspace is
    // open, and caching that emptiness would leave the menu blank for good.
    if (loaded) return;
    try {
      const parsed = JSON.parse(await invoke('model_menu'));
      providers = Array.isArray(parsed.providers) ? parsed.providers : [];
      configPath = parsed.path || '';
      loadError = parsed.error || '';
      source = parsed.source || '';
      loaded = providers.length > 0;
    } catch (error) {
      loadError = String(error?.message || error);
    }
  }


  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Type Hermes' own /model command into the pane: `/model <id>` + Enter.
   *
   * The pane's input encoding is handled by the terminal session itself (raw
   * VT or Win32 key events), so plain text with a carriage return works in
   * both modes. The choice is also recorded so a later relaunch of the pane
   * starts on the same model.
   */
  const ESC = String.fromCharCode(27);

  async function switchModel(id, model) {
    if (!model.id) return;
    const send = (data) => invoke('write_terminal', { id, data });
    try {
      await send(ESC);            // leave anything already open
      await pause(250);
      await send(`/model ${model.id}\r`);
      await invoke('remember_pane_model', { id, model: model.id }).catch(() => {});
    } catch (error) {
      console.error('Could not switch model', error);
    }
  }

  function place(element, anchor, width) {
    const box = anchor.getBoundingClientRect();
    element.style.top = `${Math.round(Math.min(box.top, window.innerHeight - 260))}px`;
    element.style.left = `${Math.round(Math.max(8, Math.min(box.right + 4, window.innerWidth - width - 8)))}px`;
  }

  let shownProvider = null;

  function openSubmenu(provider, row) {
    // Rebuilding on every mouseenter and focus destroys the row the pointer is
    // travelling towards, so the same provider must be a no-op.
    if (shownProvider === provider && !submenu.hidden) return;
    shownProvider = provider;
    submenu.replaceChildren();
    for (const model of provider.models || []) {
      // A menu entry needs a label; the model id is what gets typed as /model.
      if (!model?.label && !model.id) continue;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'model-row';
      item.setAttribute('role', 'menuitem');
      item.textContent = model.label || model.id;
      item.title = model.id ? `Runs /model ${model.id} in this pane` : '';
      item.onclick = async () => {
        close();
        await switchModel(target, model);
      };
      submenu.appendChild(item);
    }
    if (!submenu.childElementCount) {
      const empty = document.createElement('div');
      empty.className = 'model-menu-empty';
      empty.textContent = 'No models listed for this provider.';
      submenu.appendChild(empty);
    }
    place(submenu, row, 230);
    submenu.hidden = false;
  }

  let opening = 0;

  function position(button) {
    const box = button.getBoundingClientRect();
    menu.style.top = `${Math.round(box.bottom + 4)}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(box.left, window.innerWidth - 220)))}px`;
  }

  async function open(button, id) {
    target = id;
    const generation = ++opening;

    // Show the menu first, then fill it. Discovery reads Hermes' model catalog
    // and can take a moment; opening only after it returned meant the menu
    // appeared to do nothing, and on the cached path it never opened at all.
    shownProvider = null;
    menu.replaceChildren();
    if (!loaded) {
      const waiting = document.createElement('div');
      waiting.className = 'model-menu-empty';
      waiting.textContent = 'Reading your installed providers…';
      menu.appendChild(waiting);
    }
    position(button);
    menu.hidden = false;
    submenu.hidden = true;
    button.setAttribute('aria-expanded', 'true');

    await load();
    // Another pane's menu opened, or this one was closed, while discovery ran.
    if (generation !== opening || menu.hidden) return;

    menu.replaceChildren();
    for (const provider of providers) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'model-row model-provider';
      row.setAttribute('role', 'menuitem');
      row.setAttribute('aria-haspopup', 'menu');
      row.textContent = provider.label || 'Provider';
      const show = () => {
        menu.querySelectorAll('.model-provider').forEach((r) => r.classList.remove('model-row-current'));
        row.classList.add('model-row-current');
        openSubmenu(provider, row);
      };
      row.onmouseenter = show;
      row.onclick = show;
      row.onfocus = show;
      menu.appendChild(row);
    }
    if (!providers.length) {
      const empty = document.createElement('div');
      empty.className = 'model-menu-empty';
      empty.textContent = loadError || 'No providers found. Open a workspace first.';
      menu.appendChild(empty);
    }

    const note = document.createElement('div');
    note.className = 'model-menu-note';
    note.textContent = loadError
      ? loadError
      : `Switches this pane live. ${source === 'discovered' ? 'Discovered from your installed providers' : 'From models.json'}.`;
    menu.appendChild(note);
    position(button);
  }

  /** Add the burger to a pane header, once per pane. */
  function attach(pane) {
    const header = pane.querySelector('.terminal-header');
    if (!header || header.querySelector('.pane-model-btn')) return;
    const id = pane.dataset.id;
    // Every agent pane gets a picker; 'auth' is a sign-in shell, not an agent.
    if (!id || !(id === 'master' || /^hermes-\d+$/.test(id))) return;
    const group = document.createElement('span');
    group.className = 'pane-menu-group pane-menu-model';
    const label = document.createElement('span');
    label.className = 'pane-menu-label';
    label.textContent = 'Model:';
    group.appendChild(label);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn icon pane-model-btn';
    button.textContent = '☰';
    button.title = 'Choose this pane’s model';
    button.setAttribute('aria-label', `Choose the model for ${id}`);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.onclick = (event) => {
      event.stopPropagation();
      if (!menu.hidden && target === id) { close(); return; }
      open(button, id);
    };
    group.appendChild(button);
    // Far left of the header, ahead of the title.
    header.insertBefore(group, header.firstChild);
  }

  // Seed and read models.json at startup so the file the user is told to edit
  // exists before they go looking for it.
  load();

  const scan = () => document.querySelectorAll('.terminal-pane').forEach(attach);
  new MutationObserver(scan).observe(document.getElementById('app'), { childList: true, subtree: true });
  scan();

  document.addEventListener('pointerdown', (event) => {
    if (menu.hidden) return;
    const inside = menu.contains(event.target) || submenu.contains(event.target);
    if (!inside && !event.target.closest?.('.pane-model-btn')) close();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
}
