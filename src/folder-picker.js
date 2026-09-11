// In-app folder browser.
//
// Native pickers could not be made to work here: opened from a Tauri command
// thread the dialog sat behind the app, and dispatching it to the main thread
// froze the event loop. Browsing inside the WebView has no OS foreground rules
// to lose and keeps the whole flow in one window.

export function installFolderPicker(invoke, onChoose) {
  const dialog = document.createElement('dialog');
  dialog.id = 'folder-picker';
  dialog.innerHTML = `
    <div class="fp-head">
      <strong>Choose a project folder</strong>
      <input id="fp-path" type="text" spellcheck="false" autocomplete="off" aria-label="Current folder">
      <div class="fp-drives" id="fp-drives"></div>
    </div>
    <div class="fp-list" id="fp-list" role="listbox" aria-label="Folders"></div>
    <div class="fp-foot">
      <span class="fp-hint" id="fp-hint">Double-click a folder to enter it.</span>
      <span class="fp-actions">
        <button type="button" class="btn" id="fp-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="fp-open">Open this folder</button>
      </span>
    </div>`;
  document.body.appendChild(dialog);

  const pathBox = dialog.querySelector('#fp-path');
  const list = dialog.querySelector('#fp-list');
  const drives = dialog.querySelector('#fp-drives');
  const hint = dialog.querySelector('#fp-hint');
  const joinPath = (base, name) => (base.endsWith('\\') ? base + name : `${base}\\${name}`);
  let current = '';

  function addRow(label, className, onOpen) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `fp-row ${className}`.trim();
    row.textContent = label;
    row.addEventListener('click', () => {
      list.querySelectorAll('.fp-row').forEach((r) => r.classList.remove('fp-selected'));
      row.classList.add('fp-selected');
      if (onOpen.select) pathBox.value = onOpen.select;
    });
    // One click selects, double-click enters: selecting is the common case.
    row.addEventListener('dblclick', () => onOpen.enter());
    list.appendChild(row);
  }

  async function show(where) {
    hint.textContent = 'Reading…';
    try {
      const data = await invoke('list_directories', { path: where || '' });
      current = data.path;
      pathBox.value = current;
      list.replaceChildren();

      if (data.parent) {
        addRow('⬆  ..', 'fp-up', { enter: () => show(data.parent) });
      }
      for (const name of data.folders) {
        const full = joinPath(current, name);
        addRow(name, '', { select: full, enter: () => show(full) });
      }

      drives.replaceChildren();
      for (const drive of data.drives || []) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn fp-drive';
        button.textContent = drive.replace(/\\+$/, '');
        button.addEventListener('click', () => show(drive));
        drives.appendChild(button);
      }

      hint.textContent = data.folders.length
        ? `${data.folders.length} folder(s). Double-click to enter.`
        : 'No sub-folders here. Open this folder, or go up.';
    } catch (error) {
      // A missing or unreadable folder is a real answer; say so rather than
      // leaving an empty list that looks like a hang.
      list.replaceChildren();
      hint.textContent = String(error?.message || error);
    }
  }

  dialog.querySelector('#fp-cancel').addEventListener('click', () => dialog.close());
  dialog.querySelector('#fp-open').addEventListener('click', () => {
    const chosen = pathBox.value.trim();
    dialog.close();
    if (chosen) onChoose(chosen);
  });
  pathBox.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); show(pathBox.value.trim()); }
  });

  return { open: (start) => { dialog.showModal(); show(start); } };
}
