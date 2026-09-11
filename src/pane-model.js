// Per-pane model picker.
//
// Each terminal gets its own burger. The menu lists providers; each provider
// opens a submenu of its models. Choosing one relaunches that pane with the new
// model and resumes its session, because OpenCode has no scriptable mid-session
// switch: /model only raises an interactive dialog.
//
// Providers and models come from models.json beside the executable, so the list
// can be edited without a rebuild.

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

  /** Drive OpenCode's own /model dialog: open, filter, select.
   *
   * This is what the user would type, so the pane keeps its session and its
   * scrollback; nothing restarts. The choice is also recorded so a later
   * relaunch of the pane starts on the same model.
   */
  const ESC = String.fromCharCode(27);
  // The panes run OpenCode's TUI in Win32 input mode, so a raw carriage return
  // is ignored: Enter has to arrive as a key event. Letters pass through fine,
  // which is why filtering worked while the dialog never opened.
  const WIN32_ENTER = `${ESC}[13;28;13;1;0;1_${ESC}[13;28;13;0;0;1_`;
  const WIN32_DOWN = `${ESC}[40;80;0;1;0;1_${ESC}[40;80;0;0;0;1_`;

  async function switchModel(id, model) {
    const send = (data) => invoke('write_terminal', { id, data });
    try {
      await send(ESC);            // leave anything already open
      await pause(250);
      await send('/model');
      await pause(700);
      await send(WIN32_ENTER);    // run the command; this is what opens the dialog
      await pause(1200);
      if (model.filter) {
        await send(model.filter);
        await pause(800);         // the list filters as it types
      }
      for (let step = 0; step < (Number(model.down) || 0); step += 1) {
        await send(WIN32_DOWN);
        await pause(150);
      }
      await send(WIN32_ENTER);    // select the highlighted model
      if (model.id) await invoke('remember_pane_model', { id, model: model.id }).catch(() => {});
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
      // A menu entry needs a label and something to type; the model id is optional
      // and only used to remember the choice for the pane's next launch.
      if (!model?.label && !model?.filter) continue;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'model-row';
      item.setAttribute('role', 'menuitem');
      item.textContent = model.label || model.filter;
      item.title = model.filter ? `Selects "${model.filter}" in OpenCode's model dialog` : '';
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

    // Show the menu first, then fill it. Discovery shells out to opencode and
    // takes seconds; opening only after it returned meant the menu appeared to
    // do nothing, and on the cached path it never opened at all.
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
    if (!id || !(id === 'master' || /^oc-\d+$/.test(id))) return;
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
