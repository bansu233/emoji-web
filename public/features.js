(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const names = { favorites: '我的收藏', ranking: '下载排行', content: '内容管理',
    categories: '分类管理', users: '用户管理', audit: '操作日志', security: '账号安全' };
  const descriptions = {
    favorites: '常用的表情随时找得到。', ranking: '看看团队最常下载的表情。',
    content: '编辑、删除和恢复表情。', categories: '整理表情分类。',
    users: '管理成员角色与密码。', audit: '查看审核和管理操作记录。',
    security: '修改密码并管理登录设备。',
  };
  const state = { role: null, view: null, favoriteIds: new Set(), contentStatus: 'active',
    contentQuery: '', pages: { content: 1, users: 1, audit: 1 } };
  const box = $('#feature-content');
  const shell = $('#app-shell');
  const notify = (message, isError = false) => {
    const node = document.createElement('div');
    node.className = `toast ${isError ? 'toast-error' : 'toast-success'}`;
    node.textContent = message;
    $('#toast-stack').append(node);
    setTimeout(() => node.remove(), 4000);
  };
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options,
      headers: options.body && typeof options.body === 'string'
        ? { 'Content-Type': 'application/json', ...options.headers } : options.headers });
    const type = response.headers.get('content-type') || '';
    if (!response.ok) {
      const payload = type.includes('json') ? await response.json().catch(() => ({})) : {};
      throw new Error(payload.error?.message || `操作失败 (${response.status})`);
    }
    return type.includes('json') ? response.json() : response;
  }
  const json = (body) => JSON.stringify(body);
  const pager = (data, view) => data.total > data.pageSize ? `<div class="feature-pager">
    <button type="button" class="btn btn-outline btn-sm" data-page-step="-1" ${data.page <= 1 ? 'disabled' : ''}>上一页</button>
    <span>第 ${data.page} / ${Math.ceil(data.total / data.pageSize)} 页 · 共 ${data.total} 条</span>
    <button type="button" class="btn btn-outline btn-sm" data-page-step="1" ${data.page * data.pageSize >= data.total ? 'disabled' : ''}>下一页</button>
    </div>` : '';
  function updateFavoriteButtons() {
    $$('[data-favorite-id]').forEach((button) => {
      const active = state.favoriteIds.has(Number(button.dataset.favoriteId));
      button.textContent = active ? '♥' : '♡';
      button.classList.toggle('is-favorite', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }
  async function loadFavoriteIds() {
    const data = await api('/api/favorites');
    state.favoriteIds = new Set(data.items.map((item) => item.id));
    updateFavoriteButtons();
    return data.items;
  }
  async function toggleFavorite(id) {
    const active = state.favoriteIds.has(id);
    await api(`/api/favorites/${id}`, { method: active ? 'DELETE' : 'POST' });
    if (active) state.favoriteIds.delete(id); else state.favoriteIds.add(id);
    updateFavoriteButtons();
    if (state.view === 'favorites') await load('favorites');
    notify(active ? '已取消收藏' : '已加入收藏');
  }
  function cards(items, ranking = false) {
    if (!items.length) return '<p class="feature-empty">这里还没有表情。</p>';
    return `<div class="feature-grid">${items.map((item, index) => `
      <article class="feature-card">
        <img src="${esc(item.thumbnailUrl)}" alt="${esc(item.title)}" loading="lazy">
        <div class="feature-card-body"><strong>${ranking ? `${index + 1}. ` : ''}${esc(item.title)}</strong>
        <small>${esc(item.category)} · ${item.downloadCount} 次下载${item.tags?.length ? ` · ${esc(item.tags.join(' / '))}` : ''}</small>
        <div class="feature-actions"><label class="zip-select"><input class="zip-checkbox" type="checkbox" value="${item.id}"> 打包</label>
          <button type="button" class="favorite-button" data-favorite-id="${item.id}" aria-label="收藏 ${esc(item.title)}">♡</button>
          <a class="btn btn-outline btn-mini" href="${esc(item.downloadUrl)}" download>下载</a></div></div>
      </article>`).join('')}</div><div class="zip-toolbar"><button type="button" class="btn btn-outline btn-sm" data-download-selected>下载选中的表情 ZIP</button></div>`;
  }
  async function load(view) {
    if (state.view !== view) return;
    box.innerHTML = '<p class="feature-empty">正在加载…</p>';
    try {
      if (view === 'favorites') {
        const items = await loadFavoriteIds();
        box.innerHTML = cards(items);
      } else if (view === 'ranking') {
        const data = await api('/api/rankings');
        box.innerHTML = cards(data.items, true);
      } else if (view === 'content') {
        const data = await api(`/api/admin/emojis?status=${state.contentStatus}&page=${state.pages.content}&q=${encodeURIComponent(state.contentQuery)}`);
        box.innerHTML = `<div class="feature-toolbar"><button class="btn btn-outline btn-sm" data-content-status="active">当前内容</button><button class="btn btn-outline btn-sm" data-content-status="deleted">回收站</button>
          <form id="content-search" class="feature-search"><input name="q" maxlength="50" value="${esc(state.contentQuery)}" placeholder="搜索标题、分类、标签或上传者"><button class="btn btn-outline btn-sm">搜索</button></form></div>
          ${data.items.length ? `<div class="feature-list">${data.items.map((item) => `<article class="feature-row">
            <img src="${esc(item.thumbnailUrl)}" alt=""><div><strong>${esc(item.title)}</strong><small>${esc(item.owner.username)} · ${esc(item.category)} · ${esc(item.status)}${item.tags?.length ? ` · ${esc(item.tags.join(' / '))}` : ''}</small></div>
            <div class="feature-actions">${item.deletedAt
              ? `<button class="btn btn-outline btn-sm" data-restore="${item.id}">恢复</button>`
              : `<button class="btn btn-outline btn-sm" data-edit="${item.id}" data-title="${esc(item.title)}" data-category="${esc(item.category)}" data-tags="${esc(item.tags.join(','))}">编辑</button><button class="btn btn-ghost btn-sm" data-delete="${item.id}">删除</button>`}</div>
          </article>`).join('')}</div>` : '<p class="feature-empty">暂无内容。</p>'}${pager(data, view)}`;
      } else if (view === 'categories') {
        const data = await api('/api/categories');
        box.innerHTML = `<form id="category-create" class="feature-toolbar"><input name="name" maxlength="20" placeholder="新分类名称" required><button class="btn btn-primary btn-sm" type="submit">添加分类</button></form>
          <div class="feature-list">${data.items.map((item) => `<div class="feature-row"><div><strong>${esc(item.name)}</strong><small>${item.count} 张已发布</small></div><div class="feature-actions"><button class="btn btn-outline btn-sm" data-rename-category="${item.id}" data-name="${esc(item.name)}">重命名</button><button class="btn btn-ghost btn-sm" data-delete-category="${item.id}" data-name="${esc(item.name)}">删除</button></div></div>`).join('')}</div>`;
      } else if (view === 'users') {
        const data = await api(`/api/admin/users?page=${state.pages.users}`);
        box.innerHTML = `<div class="feature-list">${data.items.map((item) => `<div class="feature-row"><div><strong>${esc(item.username)}</strong><small>${item.uploadCount} 张上传 · ${esc(item.createdAt.slice(0, 10))}${item.disabledAt ? ' · 已停用' : ''}</small></div>
          <div class="feature-actions"><select data-role-user="${item.id}" aria-label="${esc(item.username)} 的角色"><option value="user" ${item.role === 'user' ? 'selected' : ''}>普通用户</option><option value="reviewer" ${item.role === 'reviewer' ? 'selected' : ''}>审核员</option><option value="admin" ${item.role === 'admin' ? 'selected' : ''}>管理员</option></select><button class="btn btn-outline btn-sm" data-reset-password="${item.id}" data-name="${esc(item.username)}">重置密码</button><button class="btn btn-ghost btn-sm" data-user-status="${item.id}" data-disabled="${item.disabledAt ? 'true' : 'false'}">${item.disabledAt ? '启用' : '停用'}</button></div></div>`).join('')}</div>${pager(data, view)}`;
      } else if (view === 'audit') {
        const data = await api(`/api/admin/audit?page=${state.pages.audit}`);
        box.innerHTML = `<div class="feature-list">${data.items.length ? data.items.map((item) => `<div class="feature-row"><div><strong>${esc(item.actor || '已删除用户')} · ${esc(item.action)}</strong><small>${esc(item.targetType)} #${esc(item.targetId)} · ${esc(item.createdAt.replace('T', ' ').slice(0, 19))}</small></div><small>${esc(item.details || '')}</small></div>`).join('') : '<p class="feature-empty">暂无操作记录。</p>'}</div>${pager(data, view)}`;
      } else if (view === 'security') {
        const data = await api('/api/auth/sessions');
        box.innerHTML = `<form id="password-form" class="feature-form"><h3>修改密码</h3><input type="password" name="currentPassword" autocomplete="current-password" placeholder="当前密码" required><input type="password" name="newPassword" autocomplete="new-password" minlength="8" placeholder="新密码（至少 8 位）" required><button class="btn btn-primary btn-sm" type="submit">保存新密码</button></form>
          <h3 class="feature-subtitle">登录设备</h3><div class="feature-list">${data.items.map((item) => `<div class="feature-row"><div><strong>${item.current ? '当前设备' : '其他设备'}</strong><small>${esc(item.userAgent || '未知浏览器')} · ${esc(item.ipAddress || '未知地址')} · ${esc(item.createdAt.slice(0, 16).replace('T', ' '))}</small></div>${item.current ? '' : `<button class="btn btn-outline btn-sm" data-revoke-session="${item.id}">移除</button>`}</div>`).join('')}</div>`;
      }
      updateFavoriteButtons();
    } catch (error) { box.innerHTML = `<p class="feature-empty">${esc(error.message)}</p>`; }
  }
  function show(view) {
    if (!names[view] || (['content', 'categories', 'users', 'audit'].includes(view) && state.role !== 'admin')) return;
    state.view = view;
    $$('.page').forEach((page) => { page.hidden = page.dataset.page !== 'feature'; });
    $$('[data-view]').forEach((button) => button.classList.remove('is-active'));
    $$('[data-feature-view]').forEach((button) => button.classList.toggle('is-active', button.dataset.featureView === view));
    $('#page-eyebrow').textContent = 'MEME VAULT';
    $('#page-title').textContent = names[view];
    $('#feature-title').textContent = names[view];
    $('#feature-description').textContent = descriptions[view];
    $('#search-wrap').hidden = true;
    $('.feature-menu').open = false;
    document.title = `${names[view]} · 表情仓`;
    history.replaceState(null, '', `#feature-${view}`);
    scrollTo({ top: 0, behavior: 'auto' });
    load(view);
  }
  async function syncAuth() {
    if (shell.hidden) { state.role = null; state.view = null; return; }
    try {
      const data = await api('/api/auth/me');
      state.role = data.user.role;
      $$('[data-admin-feature]').forEach((node) => { node.hidden = state.role !== 'admin'; });
      await loadFavoriteIds();
    } catch { state.role = null; }
  }
  async function downloadSelected() {
    const ids = [...new Set($$('.page:not([hidden]) .zip-checkbox:checked').map((box) => Number(box.value)))];
    if (!ids.length) return notify('请先勾选表情', true);
    if (ids.length > 20) return notify('每次最多下载 20 张', true);
    const response = await api('/api/emojis/download-zip', { method: 'POST', body: json({ ids }) });
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href; link.download = 'meme-vault.zip';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1500);
  }
  document.addEventListener('click', async (event) => {
    const view = event.target.closest('[data-feature-view]');
    if (view) return show(view.dataset.featureView);
    const normal = event.target.closest('[data-view]');
    if (normal) state.view = null;
    const button = event.target.closest('button, a');
    if (!button) return;
    try {
      if (button.matches('[data-favorite-id]')) await toggleFavorite(Number(button.dataset.favoriteId));
      else if (button.matches('[data-download-selected]')) await downloadSelected();
      else if (button.matches('[data-content-status]')) { state.contentStatus = button.dataset.contentStatus; state.pages.content = 1; load('content'); }
      else if (button.matches('[data-page-step]')) { state.pages[state.view] += Number(button.dataset.pageStep); load(state.view); }
      else if (button.matches('[data-restore]')) { await api(`/api/admin/emojis/${button.dataset.restore}/restore`, { method: 'POST' }); notify('已恢复'); load('content'); }
      else if (button.matches('[data-delete]')) { if (!confirm('确定移入回收站？可随时恢复。')) return; await api(`/api/emojis/${button.dataset.delete}`, { method: 'DELETE' }); notify('已移入回收站'); load('content'); }
      else if (button.matches('[data-edit]')) {
        const title = prompt('标题', button.dataset.title); if (title === null) return;
        const category = prompt('分类', button.dataset.category); if (category === null) return;
        const tags = prompt('标签（逗号分隔）', button.dataset.tags); if (tags === null) return;
        await api(`/api/emojis/${button.dataset.edit}`, { method: 'PATCH', body: json({ title, category, tags }) });
        notify('已保存'); load('content');
      } else if (button.matches('[data-rename-category]')) {
        const name = prompt('新分类名称', button.dataset.name); if (!name) return;
        await api(`/api/categories/${button.dataset.renameCategory}`, { method: 'PATCH', body: json({ name }) });
        notify('已重命名'); load('categories');
      } else if (button.matches('[data-delete-category]')) {
        if (!confirm(`删除分类“${button.dataset.name}”？其中表情会移到“未分类”。`)) return;
        await api(`/api/categories/${button.dataset.deleteCategory}`, { method: 'DELETE' });
        notify('分类已删除'); load('categories');
      } else if (button.matches('[data-reset-password]')) {
        const password = prompt(`为 ${button.dataset.name} 设置新密码（至少 8 位）`);
        if (!password) return;
        await api(`/api/admin/users/${button.dataset.resetPassword}/password`, { method: 'POST', body: json({ password }) });
        notify('密码已重置，该用户的设备已退出登录');
      } else if (button.matches('[data-user-status]')) {
        const disabled = button.dataset.disabled !== 'true';
        if (disabled && !confirm('停用账号后，该用户会立即退出所有设备。确定继续？')) return;
        await api(`/api/admin/users/${button.dataset.userStatus}/status`, { method: 'PATCH', body: json({ disabled }) });
        notify(disabled ? '账号已停用' : '账号已启用'); load('users');
      } else if (button.matches('[data-revoke-session]')) {
        await api(`/api/auth/sessions/${button.dataset.revokeSession}`, { method: 'DELETE' });
        notify('设备已移除'); load('security');
      }
    } catch (error) { notify(error.message, true); }
  });
  document.addEventListener('change', async (event) => {
    const select = event.target.closest('[data-role-user]');
    if (!select) return;
    try {
      await api(`/api/admin/users/${select.dataset.roleUser}/role`, { method: 'PATCH', body: json({ role: select.value }) });
      notify('角色已更新，该用户需重新登录');
    } catch (error) { notify(error.message, true); load('users'); }
  });
  document.addEventListener('submit', async (event) => {
    if (event.target.id === 'content-search') {
      event.preventDefault();
      state.contentQuery = event.target.elements.q.value.trim();
      state.pages.content = 1;
      load('content');
    } else if (event.target.id === 'category-create') {
      event.preventDefault();
      try { await api('/api/categories', { method: 'POST', body: json({ name: event.target.elements.name.value }) }); notify('分类已添加'); load('categories'); }
      catch (error) { notify(error.message, true); }
    } else if (event.target.id === 'password-form') {
      event.preventDefault();
      const form = event.target;
      try { await api('/api/auth/password', { method: 'POST', body: json({ currentPassword: form.elements.currentPassword.value, newPassword: form.elements.newPassword.value }) }); form.reset(); notify('密码已修改，其他设备已退出登录'); }
      catch (error) { notify(error.message, true); }
    }
  });
  new MutationObserver(syncAuth).observe(shell, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(updateFavoriteButtons).observe($('#square-grid'), { childList: true });
  syncAuth();
})();
