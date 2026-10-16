(() => {
  'use strict';
  const host = document.getElementById('project-drawer');
  const api = window.notchAPI;
  if (!host || !api) return;
  const colors = ['#8bceff', '#baabff', '#efb5d4', '#edc48d', '#9cd4b0', '#a8acb8'];
  const colorNames = ['冰蓝', '浅紫', '淡粉', '杏色', '浅绿', '灰色'];
  const folderIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3Z"/><path d="M3 8h18"/></svg>';
  const fileIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4M9 12h6M9 16h6"/></svg>';
  let data = { entries: [], categories: [], revision: -1, rootName: '全部文件' };
  let selected = new Set();
  let selectionAnchor = null;
  let active = 'all';
  let query = '';
  let busy = false;
  let loaded = false;
  let loading = false;
  let editing = null;
  let editorOpener;
  let dragging = [];
  let view = localStorage.getItem('notch-project-drawer-view') === 'list' ? 'list' : 'grid';
  host.innerHTML = `
    <aside class="pd-sidebar" aria-label="文件分类">
      <div class="pd-side-heading">我的分类</div>
      <div class="pd-categories" id="pd-categories"></div>
      <button class="pd-add" id="pd-add" type="button">＋ 新建分类</button>
      <p class="pd-side-note">单击卡片可多选<br>Shift 连选 · 拖动归类</p>
    </aside>
    <main class="pd-main">
      <header class="pd-heading"><div class="pd-heading-copy"><h2 id="pd-title">全部文件</h2>
        <button id="pd-root" class="pd-origin" type="button" title="在访达中打开源文件夹">桌面 / 全部文件 ↗</button></div>
        <button id="pd-edit" class="pd-button" type="button" hidden>编辑分类</button>
        <button id="pd-choose" class="pd-button" type="button">选择文件夹</button>
      </header>
      <div class="pd-tools"><label class="pd-select-all"><input id="pd-all" type="checkbox">全选<span id="pd-visible-count"></span></label>
        <input id="pd-search" class="pd-search" type="search" placeholder="搜索当前分类…" aria-label="搜索当前分类的文件" autocomplete="off">
        <button id="pd-view" class="pd-button" type="button" aria-label="切换到列表视图">列表</button>
        <button id="pd-refresh" class="pd-button" type="button" title="重新读取文件夹">刷新</button>
      </div>
      <div class="pd-files-scroll"><div id="pd-files" class="pd-files" aria-label="文件列表"></div><div id="pd-empty" class="pd-empty" role="status">正在读取文件夹…</div></div>
      <div class="pd-batch"><span id="pd-selected">未选择文件</span>
        <button id="pd-clear" class="pd-button" type="button" hidden>清空选择</button>
        <button id="pd-open" class="pd-button" type="button" disabled>打开</button>
        <button id="pd-reveal" class="pd-button" type="button" disabled>在访达中显示</button>
        <select id="pd-target" aria-label="归入哪个分类"><option value="__none__">选择分类</option></select>
        <button id="pd-assign" class="pd-button pd-primary" type="button" disabled>归入分类</button>
      </div>
      <footer class="pd-footer"><span id="pd-message" role="status" aria-live="polite">分类只在抽屉中生效，原文件位置不变。</span><button id="pd-undo" type="button" disabled>撤销上一步</button></footer>
    </main>
    <dialog id="pd-editor" aria-labelledby="pd-editor-title"><form id="pd-form">
      <header><h3 id="pd-editor-title">新建分类</h3><button id="pd-cancel-x" class="pd-button" type="button" aria-label="关闭分类编辑">✕</button></header>
      <label class="pd-field">分类名称<input id="pd-name" type="text" maxlength="20" required placeholder="例如：正在做的项目" autocomplete="off"></label>
      <fieldset class="pd-color-field"><legend>分类颜色</legend><div id="pd-colors"></div></fieldset>
      <p id="pd-form-error" role="alert" hidden></p><p class="pd-editor-hint">删除分类后，文件会回到「未分类」。</p>
      <div class="pd-editor-actions"><button id="pd-delete" class="pd-button pd-danger" type="button" hidden>删除分类</button><button id="pd-cancel" class="pd-button" type="button">取消</button><button id="pd-save" class="pd-button pd-primary" type="submit">创建分类</button></div>
    </form></dialog>`;
  const $ = (id) => document.getElementById(`pd-${id}`);
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function dot(color) { const node = element('span', 'pd-dot'); node.style.backgroundColor = color; return node; }
  function currentEntries() {
    return data.entries.filter((entry) => (active === 'all' || entry.category === active)
      && entry.name.toLocaleLowerCase().includes(query));
  }
  function clearSelection() { selected.clear(); selectionAnchor = null; }
  function paintSelection() {
    // Preserve nodes so native double-click, focus and dragging remain stable.
    $('files').querySelectorAll('[data-entry]').forEach((node) => {
      const checked = selected.has(node.dataset.entry);
      node.classList.toggle('is-selected', checked);
      node.querySelector('input').checked = checked;
    });
    controls();
  }
  function selectEntry(id, extend = false) {
    const ids = currentEntries().map((entry) => entry.id);
    const from = ids.indexOf(selectionAnchor), to = ids.indexOf(id);
    if (extend && from >= 0 && to >= 0) {
      for (const entryId of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) selected.add(entryId);
    } else {
      selected.has(id) ? selected.delete(id) : selected.add(id);
      selectionAnchor = id;
    }
    paintSelection();
  }
  function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('is-error', error); }
  function accept(snapshot) {
    if (!snapshot || snapshot.revision < data.revision) return;
    const oldIds = new Set(data.entries.map((e) => e.id));
    const wasLoaded = loaded;
    data = snapshot;
    loaded = true;
    if (active !== 'all' && active && !data.categories.some((c) => c.id === active)) active = '';
    selected = new Set([...selected].filter((id) => data.entries.some((e) => e.id === id)));
    if (!data.entries.some((e) => e.id === selectionAnchor)) selectionAnchor = null;
    render();
    if (data.error) message(data.error, true);
    else if (wasLoaded) {
      const added = data.entries.filter((e) => !oldIds.has(e.id)).length;
      if (added) message(`已同步 ${added} 个新项目，可在「未分类」中归类。`);
    }
  }
  async function request(fn, success) {
    if (busy) return false;
    busy = true; controls();
    try {
      const result = await fn();
      if (!result?.ok) throw new Error(result?.error || '操作失败，请重试。');
      if (result.snapshot) accept(result.snapshot);
      if (success && !result.canceled) message(success);
      return !result.canceled;
    } catch (error) {
      message(error.message, true);
      if ($('editor').open) { $('form-error').textContent = error.message; $('form-error').hidden = false; }
      return false;
    } finally { busy = false; controls(); }
  }
  async function refresh(manual = false) {
    if (loading) return;
    loading = true;
    const result = await request(() => api.listProjectDrawer(), manual ? '文件列表已更新。' : '已同步文件夹。新增文件将自动加入「未分类」。');
    loading = false;
    if (!result && !loaded) { $('empty').hidden = false; $('empty').textContent = '暂时无法读取文件夹。请刷新或选择文件夹重试。'; }
    if (data.error) message(data.error, true);
  }
  function controls() {
    const visible = currentEntries();
    const selectedVisible = visible.filter((e) => selected.has(e.id)).length;
    $('all').checked = visible.length > 0 && selectedVisible === visible.length;
    $('all').indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
    $('all').disabled = busy || !visible.length;
    $('selected').textContent = selected.size ? `已选择 ${selected.size} 项` : '未选择文件';
    $('clear').hidden = !selected.size;
    $('clear').disabled = busy;
    $('open').disabled = busy || selected.size !== 1;
    $('reveal').disabled = busy || selected.size !== 1;
    $('assign').disabled = busy || !selected.size || $('target').value === '__none__' || Boolean(data.error);
    $('undo').disabled = busy || !data.canUndo;
    for (const id of ['add', 'edit', 'choose', 'refresh', 'save', 'delete']) $(id).disabled = busy;
    $('target').disabled = busy;
    $('name').disabled = busy;
    host.setAttribute('aria-busy', String(busy));
    host.querySelectorAll('[data-entry] input').forEach((input) => { input.disabled = busy; });
  }
  function renderCategories() {
    const fragment = document.createDocumentFragment();
    const categories = [{ id: 'all', name: '全部文件', color: '#c5c8d0' }, { id: '', name: '未分类', color: '#737985' }, ...data.categories];
    for (const category of categories) {
      const button = element('button', 'pd-category'); button.type = 'button'; button.dataset.category = category.id;
      button.setAttribute('aria-pressed', String(active === category.id));
      button.title = category.name;
      button.append(dot(category.color), element('span', 'pd-cat-name', category.name), element('span', 'pd-count', String(category.id === 'all' ? data.entries.length : data.entries.filter((e) => e.category === category.id).length)));
      fragment.append(button);
    }
    $('categories').replaceChildren(fragment);
    const target = $('target').value;
    $('target').replaceChildren(new Option('选择分类', '__none__'), new Option('未分类', ''), ...data.categories.map((c) => new Option(c.name, c.id)));
    $('target').value = [...$('target').options].some((o) => o.value === target) ? target : '__none__';
  }
  function renderFiles(source = window.cardReflow?.capture($('files'))) {
    const focusedId = document.activeElement?.closest('[data-entry]')?.dataset.entry;
    const wasCheckbox = document.activeElement?.tagName === 'INPUT';
    const visible = currentEntries();
    const fragment = document.createDocumentFragment();
    for (const entry of visible) {
      const card = element('div', `pd-file${selected.has(entry.id) ? ' is-selected' : ''}`);
      card.dataset.entry = entry.id; card.tabIndex = 0; card.draggable = true;
      card.setAttribute('role', 'group'); card.setAttribute('aria-label', entry.name);
      card.title = `${entry.name}\n单击选择，再次单击取消 · Shift 连选\n双击或按 Enter 打开`;
      const top = element('div', 'pd-file-top');
      const icon = element('span', `pd-file-icon ${entry.kind}`); icon.setAttribute('aria-hidden', 'true'); icon.innerHTML = entry.kind === 'folder' ? folderIcon : fileIcon;
      const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(entry.id); checkbox.setAttribute('aria-label', `选择 ${entry.name}`);
      const checkTarget = element('label', 'pd-select-hit'); checkTarget.title = `选择 ${entry.name}`; checkTarget.append(checkbox);
      top.append(icon, checkTarget);
      const copy = element('div', 'pd-file-copy');
      const name = element('span', 'pd-file-name', entry.name);
      const category = data.categories.find((c) => c.id === entry.category);
      const label = element('span', 'pd-file-category'); label.append(dot(category?.color || '#737985'), document.createTextNode(category?.name || '未分类'));
      copy.append(name, label); card.append(top, copy); fragment.append(card);
    }
    $('files').replaceChildren(fragment);
    $('empty').hidden = Boolean(visible.length);
    $('empty').textContent = data.error || (!loaded ? '正在读取文件夹…' : query ? '这个分类里没有匹配的文件。' : active === 'all' ? '文件夹还没有文件。新文件会自动出现在这里。' : active === '' ? '所有文件都已归类。' : '这个分类还是空的。从「全部文件」拖入，或勾选文件后归入此分类。');
    $('visible-count').textContent = `（${visible.length}）`;
    if (focusedId) {
      const card = [...$('files').children].find((c) => c.dataset.entry === focusedId);
      (wasCheckbox ? card?.querySelector('input') : card)?.focus({ preventScroll: true });
    }
    controls();
    void window.cardReflow?.play(source, $('files'));
  }
  function render() {
    const source = window.cardReflow?.capture($('files'));
    const focusedCategory = document.activeElement?.dataset.category;
    $('title').textContent = active === 'all' ? '全部文件' : active === '' ? '未分类' : data.categories.find((c) => c.id === active)?.name || '未分类';
    $('root').textContent = `${data.rootName || '全部文件'} ↗`;
    $('root').title = data.root || '在访达中打开源文件夹';
    $('edit').hidden = active === 'all' || active === '';
    host.dataset.view = view;
    $('view').textContent = view === 'grid' ? '列表' : '卡片';
    $('view').setAttribute('aria-label', view === 'grid' ? '切换到列表视图' : '切换到卡片视图');
    renderCategories(); renderFiles(source);
    if (focusedCategory !== undefined) [...$('categories').children].find((b) => b.dataset.category === focusedCategory)?.focus({ preventScroll: true });
  }
  function closeEditor() {
    if (!$('editor').open || busy) return false;
    if (!$('form-error').hidden) message(data.error || '分类只在抽屉中生效，原文件位置不变。', Boolean(data.error));
    $('editor').close(); editing = null; editorOpener?.focus({ preventScroll: true }); return true;
  }
  function showEditor(id = null) {
    if (busy) return;
    const category = data.categories.find((c) => c.id === id);
    editing = category?.id || null; editorOpener = document.activeElement;
    $('editor-title').textContent = editing ? '编辑分类' : '新建分类';
    $('save').textContent = editing ? '保存修改' : '创建分类';
    $('delete').hidden = !editing; $('form-error').hidden = true;
    $('name').value = category?.name || '';
    $('colors').replaceChildren(...colors.map((color, index) => {
      const label = element('label', 'pd-swatch'); label.title = colorNames[index];
      const input = element('input'); input.type = 'radio'; input.name = 'pd-color'; input.value = color; input.checked = color === (category?.color || colors[0]); input.setAttribute('aria-label', colorNames[index]);
      const circle = element('span'); circle.style.backgroundColor = color; label.append(input, circle); return label;
    }));
    $('editor').showModal(); $('name').focus();
  }
  $('add').addEventListener('click', () => showEditor());
  $('edit').addEventListener('click', () => showEditor(active));
  for (const id of ['cancel', 'cancel-x']) $(id).addEventListener('click', closeEditor);
  $('editor').addEventListener('cancel', (event) => { event.preventDefault(); closeEditor(); });
  $('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const saved = await request(() => api.mutateProjectDrawer({ type: 'save-category', id: editing, name: $('name').value, color: host.querySelector('input[name="pd-color"]:checked')?.value }), editing ? '分类已更新。' : '分类已创建，可以拖入文件了。');
    if (saved) closeEditor();
  });
  $('delete').addEventListener('click', async () => {
    if (await request(() => api.mutateProjectDrawer({ type: 'delete-category', id: editing }), '分类已删除，文件回到「未分类」。可撤销。')) closeEditor();
  });
  $('categories').addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]'); if (!button) return;
    active = button.dataset.category; clearSelection(); render();
  });
  $('search').addEventListener('input', () => { query = $('search').value.trim().toLocaleLowerCase(); clearSelection(); renderFiles(); });
  $('all').addEventListener('change', () => { selected = new Set($('all').checked ? currentEntries().map((e) => e.id) : []); selectionAnchor = null; paintSelection(); });
  $('clear').addEventListener('click', () => { clearSelection(); paintSelection(); });
  $('files').addEventListener('click', (event) => {
    const card = event.target.closest('[data-entry]'); if (!card || busy) return;
    // A label forwards its click to the checkbox; process only that forwarded
    // click so the larger hit area does not toggle the same item twice.
    if (event.target.closest('.pd-select-hit') && event.target.tagName !== 'INPUT') return;
    if (event.target.tagName !== 'INPUT' && event.detail > 1) return;
    selectEntry(card.dataset.entry, event.shiftKey);
  });
  $('files').addEventListener('dblclick', (event) => {
    const card = event.target.closest('[data-entry]');
    if (!card || event.target.closest('.pd-select-hit') || busy || event.shiftKey || event.metaKey || event.ctrlKey) return;
    selected.add(card.dataset.entry); paintSelection();
    void request(() => api.openDrawerEntry(card.dataset.entry));
  });
  $('files').addEventListener('keydown', (event) => {
    const card = event.target.closest('[data-entry]'); if (!card || event.target.tagName === 'INPUT') return;
    if (event.key === 'Enter') { event.preventDefault(); void request(() => api.openDrawerEntry(card.dataset.entry)); }
    if (event.key === ' ') { event.preventDefault(); if (!busy && !event.repeat) selectEntry(card.dataset.entry, event.shiftKey); }
  });
  host.addEventListener('keydown', (event) => {
    if (busy || $('editor').open || !(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing || event.key.toLowerCase() !== 'a') return;
    if (event.target.closest('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]')) return;
    event.preventDefault(); event.stopPropagation();
    selected = new Set(currentEntries().map((entry) => entry.id)); selectionAnchor = null; paintSelection();
  });
  $('files').addEventListener('dragstart', (event) => {
    const card = event.target.closest('[data-entry]'); if (!card || busy || event.target.closest('.pd-select-hit')) { event.preventDefault(); return; }
    dragging = selected.has(card.dataset.entry) ? [...selected] : [card.dataset.entry];
    event.dataTransfer.setData('application/x-fudao-projects', JSON.stringify(dragging)); event.dataTransfer.effectAllowed = 'move';
  });
  const clearDrop = () => { host.querySelectorAll('.is-drop').forEach((n) => n.classList.remove('is-drop')); };
  $('files').addEventListener('dragend', () => { dragging = []; clearDrop(); });
  $('categories').addEventListener('dragover', (event) => {
    const button = event.target.closest('[data-category]');
    if (!dragging.length || !button || button.dataset.category === 'all' || busy) return;
    event.preventDefault(); clearDrop(); button.classList.add('is-drop'); event.dataTransfer.dropEffect = 'move';
  });
  $('categories').addEventListener('dragleave', (event) => { if (!event.currentTarget.contains(event.relatedTarget)) clearDrop(); });
  $('categories').addEventListener('drop', async (event) => {
    const button = event.target.closest('[data-category]'); clearDrop();
    if (!dragging.length || !button || button.dataset.category === 'all' || busy) return;
    event.preventDefault(); const ids = dragging; dragging = [];
    if (await request(() => api.mutateProjectDrawer({ type: 'assign', ids, category: button.dataset.category }), `已归类 ${ids.length} 项。`)) { clearSelection(); renderFiles(); }
  });
  $('target').addEventListener('change', controls);
  $('assign').addEventListener('click', async () => {
    const ids = [...selected]; const category = $('target').value;
    if (await request(() => api.mutateProjectDrawer({ type: 'assign', ids, category }), `已归类 ${ids.length} 项。`)) { clearSelection(); renderFiles(); }
  });
  $('undo').addEventListener('click', () => request(() => api.mutateProjectDrawer({ type: 'undo' }), '已撤销上一步。'));
  $('open').addEventListener('click', () => request(() => api.openDrawerEntry([...selected][0])));
  $('reveal').addEventListener('click', () => request(() => api.revealDrawerEntry([...selected][0])));
  $('root').addEventListener('click', () => request(() => api.openDrawerRoot()));
  $('choose').addEventListener('click', async () => { if (await request(() => api.chooseDrawerRoot())) { active = 'all'; clearSelection(); query = ''; $('search').value = ''; render(); message('已切换文件夹，文件列表会自动更新。'); } });
  $('refresh').addEventListener('click', () => refresh(true));
  $('view').addEventListener('click', () => { view = view === 'grid' ? 'list' : 'grid'; localStorage.setItem('notch-project-drawer-view', view); render(); });
  const unsubscribe = api.onProjectDrawerChanged?.(accept);
  window.addEventListener('unload', () => unsubscribe?.());
  document.addEventListener('notch:tabchange', (event) => { closeEditor(); if (event.detail?.tab === 'projects') void refresh(); });
  document.addEventListener('notch:modechange', (event) => { if (!event.detail?.expanded) closeEditor(); else if (host.closest('.tab-panel')?.classList.contains('active')) void refresh(); });
  window.NotchProjectDrawer = { closeTransient() {
    if ($('editor').open) { closeEditor(); return true; }
    if (host.closest('.tab-panel')?.classList.contains('active') && selected.size) { clearSelection(); paintSelection(); return true; }
    return false;
  } };
  render();
})();
