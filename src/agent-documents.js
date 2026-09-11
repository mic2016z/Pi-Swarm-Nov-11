/**
 * Agent Documents Manager & Editor
 * Provides quick document inspection and editing (agent.md, context.md, todo.md)
 * per terminal pane with concurrency protection, modal state trapping, and focus restoration.
 */

const DOC_FILES = ['agent.md', 'context.md', 'todo.md'];

export function installAgentDocuments(invoke) {
  if (document.getElementById('agent-document-dialog')) return;

  // --- Dialog DOM Construction ---
  const dialog = document.createElement('dialog');
  dialog.id = 'agent-document-dialog';
  dialog.className = 'agent-doc-dialog';
  dialog.setAttribute('aria-labelledby', 'agent-doc-filename');
  dialog.innerHTML = `
    <div class="agent-doc-frame">
      <header class="agent-doc-header">
        <div class="agent-doc-meta">
          <h2 class="agent-doc-title">
            <span id="agent-doc-filename">document.md</span>
            <span class="agent-doc-pane-badge" id="agent-doc-target"></span>
          </h2>
          <div class="agent-doc-path" id="agent-doc-path" title="File location"></div>
        </div>
        <div class="agent-doc-header-actions">
          <span class="agent-doc-status" id="agent-doc-status" role="status" aria-live="polite"></span>
        </div>
      </header>

      <div class="agent-doc-error" id="agent-doc-error" role="alert" hidden></div>

      <div class="agent-doc-editor-wrap">
        <textarea
          id="agent-doc-textarea"
          class="agent-doc-textarea" aria-label="Document contents"
          placeholder="Empty document..."
          spellcheck="false"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
        ></textarea>
      </div>

      <footer class="agent-doc-footer">
        <span class="agent-doc-hint"><kbd>Ctrl</kbd>+<kbd>S</kbd> to save</span>
        <div class="agent-doc-actions">
          <button type="button" class="btn" id="agent-doc-cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="agent-doc-save">Save document</button>
        </div>
      </footer>
    </div>
  `;
  document.body.appendChild(dialog);

  // --- Component References ---
  const discardBox = document.createElement('section');
  discardBox.className = 'agent-doc-discard';
  discardBox.hidden = true;
  discardBox.innerHTML = '<span>Discard unsaved changes?</span><button class="btn" type="button">Keep editing</button><button class="btn" type="button">Discard changes</button>';
  dialog.querySelector('.agent-doc-footer').before(discardBox);
  discardBox.querySelectorAll('button')[0].onclick = () => { discardBox.hidden = true; textarea.focus(); };
  discardBox.querySelectorAll('button')[1].onclick = () => dialog.close();
  const filenameEl = dialog.querySelector('#agent-doc-filename');
  const targetEl = dialog.querySelector('#agent-doc-target');
  const pathEl = dialog.querySelector('#agent-doc-path');
  const statusEl = dialog.querySelector('#agent-doc-status');
  const errorEl = dialog.querySelector('#agent-doc-error');
  const textarea = dialog.querySelector('#agent-doc-textarea');
  const cancelBtn = dialog.querySelector('#agent-doc-cancel');
  const saveBtn = dialog.querySelector('#agent-doc-save');

  // --- Session State ---
  let currentId = null;
  let currentFilename = null;
  let initialContent = '';
  let lastOpener = null;
  let isSaving = false;
  let isLoading = false;
  let loaded = false;

  const showError = (msg) => {
    if (!msg) {
      errorEl.textContent = '';
      errorEl.hidden = true;
    } else {
      errorEl.textContent = msg;
      errorEl.hidden = false;
    }
  };

  const setBusy = (busy) => {
    textarea.disabled = busy;
    saveBtn.disabled = busy;
    cancelBtn.disabled = busy;
  };

  const hasUnsavedChanges = () => textarea.value !== initialContent;

  const requestClose = () => {
    if (isSaving || isLoading) return;
    if (hasUnsavedChanges()) {
      discardBox.hidden = false;
      discardBox.querySelector('button').focus();
      return;
    }
    dialog.close();
  };

  // --- Modal Open & Fetch ---
  const openDocument = async (id, filename, opener) => {
    lastOpener = opener;
    currentId = id;
    currentFilename = filename;
    initialContent = '';
    isLoading = true;
    loaded = false;
    discardBox.hidden = true;
    isSaving = false;

    filenameEl.textContent = filename;
    targetEl.textContent = opener.closest('.terminal-pane').querySelector('.terminal-title').textContent;
    dialog.querySelector('.agent-doc-hint').textContent = 'Saved changes apply at a safe turn boundary. Ctrl+S to save.';
    pathEl.textContent = 'Resolving file path...';
    pathEl.title = '';
    showError('');
    statusEl.textContent = 'Loading...';
    textarea.value = '';

    setBusy(true);
    dialog.showModal();

    try {
      const raw = await invoke('read_agent_document', { id, filename });
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

      loaded = true;
      initialContent = data?.content ?? '';
      textarea.value = initialContent;
      pathEl.textContent = data?.path || '';
      pathEl.title = data?.path || '';
      statusEl.textContent = '';
      isLoading = false;
      setBusy(false);
      textarea.focus();
    } catch (err) {
      isLoading = false;
      setBusy(false);
      // Keep save disabled on load failure, but enable cancel so the user is not trapped
      saveBtn.disabled = true;
      statusEl.textContent = '';
      showError(err?.message || String(err));
    }
  };

  // --- Modal Save ---
  const saveDocument = async () => {
    if (!loaded || isSaving || isLoading || !currentId || !currentFilename) return;

    isSaving = true;
    showError('');
    statusEl.textContent = 'Saving...';
    setBusy(true);

    try {
      const content = textarea.value;
      const raw = await invoke('save_agent_document', {
        id: currentId,
        filename: currentFilename,
        content,
        expected: initialContent,
      });
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

      initialContent = data?.content ?? content;
      if (data?.path) {
        pathEl.textContent = data.path;
        pathEl.title = data.path;
      }

      statusEl.textContent = 'Saved';
      isSaving = false;
      setBusy(false);
      const receipts = Object.values(data?.notifications || {});
      const failed = receipts.filter(receipt => !['queued', 'delivered', 'replied'].includes(receipt?.status));
      if (data?.notification_warning || failed.length) {
        showError(data.notification_warning || 'Document saved. Some agent notifications are pending or delivery is uncertain.');
      } else {
        dialog.close();
      }
    } catch (err) {
      isSaving = false;
      setBusy(false);
      statusEl.textContent = '';
      showError(err?.message || String(err));
      textarea.focus();
    }
  };

  // --- Dialog Events ---
  cancelBtn.onclick = requestClose;
  saveBtn.onclick = saveDocument;

  dialog.addEventListener('cancel', e => { e.preventDefault(); requestClose(); });

  // Restore focus to triggering button
  dialog.addEventListener('close', () => {
    if (lastOpener && typeof lastOpener.focus === 'function') {
      lastOpener.focus();
    }
    lastOpener = null;
    currentId = null;
    currentFilename = null;
  });

  // Hotkeys & Textarea tab support
  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveDocument();

    }
  });

  let activeMenu = null;
  const closeMenu = (restore = false) => {
    if (!activeMenu) return;
    const { menu, button } = activeMenu;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    activeMenu = null;
    if (restore) button.focus();
  };
  document.addEventListener('pointerdown', event => {
    if (activeMenu && !activeMenu.menu.contains(event.target) && !activeMenu.button.contains(event.target)) closeMenu();
  });
  window.addEventListener('resize', () => closeMenu());
  window.addEventListener('scroll', () => closeMenu(), true);

  // --- Terminal Pane Attachment ---
  const attachToPanes = () => {
    document.querySelectorAll('.terminal-pane').forEach((card) => {
      const id = card.dataset.id;
      // Exclude auth pane and uninitialized cards
      if (!id || id === 'auth') return;

      const header = card.querySelector('.terminal-header');
      if (!header || card.querySelector('.terminal-doc-group')) return;

      const group = document.createElement('div');
      group.className = 'terminal-doc-group pane-menu-group pane-menu-agent';
      const groupLabel = document.createElement('span');
      groupLabel.className = 'pane-menu-label';
      groupLabel.textContent = 'Agent:';
      group.appendChild(groupLabel);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn terminal-doc-toggle';
      button.textContent = '\u2630';
      button.title = 'Agent documents';
      button.setAttribute('aria-label', `Agent documents for ${id}`);
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-expanded', 'false');
      const menu = document.createElement('div');
      menu.className = 'terminal-doc-menu';
      menu.id = `agent-doc-menu-${id}`;
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', `Documents for ${id}`);
      menu.hidden = true;
      button.setAttribute('aria-controls', menu.id);
      document.body.appendChild(menu);
      group.appendChild(button);
      DOC_FILES.forEach(file => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'terminal-doc-item';
        item.textContent = file;
        item.setAttribute('role', 'menuitem');
        item.tabIndex = -1;
        item.onclick = () => { closeMenu(); openDocument(id, file, button); };
        menu.appendChild(item);
      });
      button.onclick = event => {
        event.stopPropagation();
        const wasOpen = activeMenu?.button === button;
        closeMenu();
        if (wasOpen) return;
        menu.hidden = false;
        const rect = button.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`;
        button.setAttribute('aria-expanded', 'true');
        activeMenu = { menu, button };
        menu.firstElementChild.focus();
      };
      button.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); if (activeMenu?.button !== button) button.click(); }
      });
      menu.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
        if (event.key === 'Tab') closeMenu(true);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const items = [...menu.children];
          const index = items.indexOf(document.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next].focus();
        }
      });

      // Insert before badge, or after rename if available
      const renameBtn = header.querySelector('.terminal-rename');
      const badge = header.querySelector('.terminal-badge');

      if (renameBtn && renameBtn.nextSibling) {
        header.insertBefore(group, renameBtn.nextSibling);
      } else if (badge) {
        header.insertBefore(group, badge);
      } else {
        header.appendChild(group);
      }
    });
  };

  // --- Observer for dynamically spawned panes ---
  const observer = new MutationObserver(attachToPanes);
  const appContainer = document.getElementById('app') || document.body;
  observer.observe(appContainer, { childList: true, subtree: true });

  attachToPanes();
}
