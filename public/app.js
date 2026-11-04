'use strict';

(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const ALLOWED_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
  const DEFAULT_CATEGORIES = ['开心', '无语', '搞笑', '猫猫', '职场', '日常'];

  const VIEW_META = {
    square: { eyebrow: 'DISCOVER', title: '表情广场', document: '表情广场' },
    mine: { eyebrow: 'CREATIONS', title: '我的上传', document: '我的上传' },
    review: { eyebrow: 'REVIEW', title: '审核台', document: '审核台' },
  };

  const STATUS_META = {
    approved: { label: '已发布', className: 'status-approved', icon: 'check' },
    pending: { label: '待审核', className: 'status-pending', icon: 'clock' },
    rejected: { label: '未通过', className: 'status-rejected', icon: 'x' },
  };

  const byId = (id) => document.getElementById(id);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const els = {
    authScreen: byId('auth-screen'),
    appShell: byId('app-shell'),
    authForm: byId('auth-form'),
    authUsername: byId('auth-username'),
    authPassword: byId('auth-password'),
    authConfirm: byId('auth-confirm'),
    confirmField: byId('confirm-field'),
    authError: byId('auth-error'),
    authSubmit: byId('auth-submit'),
    authKicker: byId('auth-kicker'),
    authTitle: byId('auth-title'),
    authSubtitle: byId('auth-subtitle'),
    authHint: byId('auth-hint'),
    authTabs: $$('.auth-tab'),
    userAvatar: byId('user-avatar'),
    userName: byId('user-name'),
    userRole: byId('user-role'),
    logoutBtn: byId('logout-btn'),
    pageEyebrow: byId('page-eyebrow'),
    pageTitle: byId('page-title'),
    searchWrap: byId('search-wrap'),
    searchInput: byId('search-input'),
    categoryRow: byId('category-row'),
    resultLine: byId('result-line'),
    squareGrid: byId('square-grid'),
    squareEmpty: byId('square-empty'),
    squareEmptyText: byId('square-empty-text'),
    loadMoreWrap: byId('load-more-wrap'),
    loadMoreBtn: byId('load-more-btn'),
    sortButtons: $$('[data-sort]'),
    mineGrid: byId('mine-grid'),
    mineEmpty: byId('mine-empty'),
    mineCount: byId('mine-count'),
    reviewList: byId('review-list'),
    reviewEmpty: byId('review-empty'),
    reviewSummary: byId('review-summary'),
    reviewCount: byId('review-count'),
    reviewBadge: byId('review-badge'),
    mobileReviewBadge: byId('mobile-review-badge'),
    reviewRoleLabel: byId('review-role-label'),
    uploadDialog: byId('upload-dialog'),
    uploadForm: byId('upload-form'),
    dropZone: byId('drop-zone'),
    fileInput: byId('file-input'),
    dropEmpty: byId('drop-empty'),
    dropPreview: byId('drop-preview'),
    previewImg: byId('preview-img'),
    previewName: byId('preview-name'),
    previewMeta: byId('preview-meta'),
    removeFile: byId('remove-file'),
    uploadTitleInput: byId('upload-title-input'),
    uploadCategory: byId('upload-category'),
    uploadTags: byId('upload-tags'),
    categoryOptions: byId('category-options'),
    uploadNoteText: byId('upload-note-text'),
    uploadError: byId('upload-error'),
    uploadSubmit: byId('upload-submit'),
    rejectDialog: byId('reject-dialog'),
    rejectForm: byId('reject-form'),
    rejectTarget: byId('reject-target'),
    rejectNote: byId('reject-note'),
    rejectError: byId('reject-error'),
    rejectSubmit: byId('reject-submit'),
    toastStack: byId('toast-stack'),
  };

  const state = {
    user: null,
    view: 'square',
    authMode: 'login',
    authBusy: false,
    categories: [],
    square: {
      items: [],
      total: 0,
      page: 1,
      pageSize: 24,
      q: '',
      category: '全部',
      sort: 'latest',
      loading: false,
      loaded: false,
      hasMore: false,
      requestId: 0,
      controller: null,
    },
    mine: { items: [], loading: false },
    review: { items: [], total: 0, loading: false },
    uploadFile: null,
    uploadFiles: [],
    uploadPreviewUrl: null,
    uploadBusy: false,
    rejectItem: null,
    rejectBusy: false,
  };

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function buttonWithIcon(className, iconName, label) {
    const button = el('button', className);
    button.type = 'button';
    button.append(icon(iconName), el('span', null, label));
    return button;
  }

  function iconOnlyButton(className, iconName, label) {
    const button = el('button', className);
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.append(icon(iconName));
    return button;
  }

  function isStaff() {
    return Boolean(state.user && (state.user.role === 'reviewer' || state.user.role === 'admin'));
  }

  function setFormError(node, message) {
    node.textContent = message || '';
    node.hidden = !message;
  }

  function setButtonBusy(button, busy, idleLabel, busyLabel) {
    if (!button) return;
    button.disabled = busy;
    button.classList.toggle('is-loading', busy);
    const span = button.querySelector('span');
    if (span) span.textContent = busy ? busyLabel : idleLabel;
  }

  function formatRelative(iso) {
    if (!iso) return '';
    const timestamp = new Date(iso).getTime();
    if (!Number.isFinite(timestamp)) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return '刚刚';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} 天前`;
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'short',
      day: 'numeric',
    }).format(new Date(timestamp));
  }

  function formatFullDate(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
    if (bytes >= 1024 * 1024) {
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function extensionForMime(mime) {
    if (mime === 'image/jpeg') return '.jpg';
    if (mime === 'image/gif') return '.gif';
    if (mime === 'image/webp') return '.webp';
    return '.png';
  }

  function toast(message, type = 'success') {
    const node = el('div', `toast${type === 'error' ? ' is-error' : ''}`);
    const badge = el('span', 'toast-icon');
    badge.append(icon(type === 'error' ? 'x' : 'check'));
    node.append(badge, el('span', null, message));
    els.toastStack.append(node);

    while (els.toastStack.children.length > 3) {
      els.toastStack.firstElementChild.remove();
    }

    window.setTimeout(() => {
      node.classList.add('is-leaving');
      window.setTimeout(() => node.remove(), 220);
    }, 2800);
  }

  function clearToasts() {
    els.toastStack.replaceChildren();
  }

  async function api(path, options = {}) {
    const init = {
      method: options.method || 'GET',
      headers: {},
      credentials: 'same-origin',
    };
    if (options.signal) init.signal = options.signal;

    if (options.body !== undefined) {
      if (options.body instanceof FormData) {
        init.body = options.body;
      } else {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }
    }

    let response;
    try {
      response = await fetch(path, init);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      const networkError = new Error('网络连接失败，请检查服务是否启动');
      networkError.cause = error;
      throw networkError;
    }

    const contentType = response.headers.get('content-type') || '';
    let payload = null;
    if (contentType.includes('application/json')) {
      payload = await response.json().catch(() => null);
    }

    if (!response.ok) {
      if (response.status === 401 && state.user && !path.startsWith('/api/auth/')) {
        handleSessionExpired();
      }
      const error = new Error(payload?.error?.message || `请求失败（${response.status}）`);
      error.status = response.status;
      error.code = payload?.error?.code;
      throw error;
    }

    return payload;
  }

  function switchAuthMode(mode, { clearError = true } = {}) {
    if (state.authBusy) return;
    state.authMode = mode === 'register' ? 'register' : 'login';
    const register = state.authMode === 'register';

    els.authTabs.forEach((tab) => {
      const active = tab.dataset.authTab === state.authMode;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });

    els.authKicker.textContent = register ? 'JOIN THE VAULT' : 'WELCOME BACK';
    els.authTitle.textContent = register ? '创建你的账号' : '欢迎回来';
    els.authSubtitle.textContent = register
      ? '注册后就可以上传和下载表情。'
      : '登录后继续收集今天的好心情。';
    els.confirmField.hidden = !register;
    els.authConfirm.required = register;
    els.authConfirm.value = '';
    els.authPassword.value = '';
    els.authPassword.autocomplete = register ? 'new-password' : 'current-password';

    const span = els.authSubmit.querySelector('span');
    if (span) span.textContent = register ? '创建账号' : '进入表情仓';

    if (clearError) setFormError(els.authError, '');
    els.authHint.innerHTML = register
      ? '已经有账号？<button type="button" class="text-btn" data-auth-switch="login">直接登录</button>'
      : '还没有账号？<button type="button" class="text-btn" data-auth-switch="register">立即注册</button>';
  }

  function setAuthBusy(busy) {
    state.authBusy = busy;
    els.authUsername.disabled = busy;
    els.authPassword.disabled = busy;
    els.authConfirm.disabled = busy;
    els.authSubmit.disabled = busy;
    els.authTabs.forEach((tab) => {
      tab.disabled = busy;
    });
    const span = els.authSubmit.querySelector('span');
    if (span) {
      if (busy) {
        span.textContent = state.authMode === 'register' ? '正在创建…' : '正在登录…';
      } else {
        span.textContent = state.authMode === 'register' ? '创建账号' : '进入表情仓';
      }
    }
  }

  function showAuth(mode = 'login', message = '') {
    state.user = null;
    clearToasts();
    resetWorkspaceState();
    closeDialogs();
    els.appShell.hidden = true;
    els.authScreen.hidden = false;
    switchAuthMode(mode);
    els.authForm.reset();
    setFormError(els.authError, message);
    document.title = '登录 · 表情仓';
    history.replaceState(null, '', location.pathname);
  }

  function handleSessionExpired() {
    if (!state.user) return;
    showAuth('login', '登录已过期，请重新登录。');
  }

  function enterApp(user) {
    state.user = user;
    clearToasts();
    els.authScreen.hidden = true;
    els.appShell.hidden = false;
    els.userAvatar.textContent = Array.from(user.username)[0]?.toUpperCase() || 'U';
    els.userName.textContent = user.username;
    els.userRole.textContent = user.roleLabel;
    els.reviewRoleLabel.textContent = user.roleLabel;

    $$('[data-staff-only]').forEach((node) => {
      node.hidden = !isStaff();
    });

    els.uploadNoteText.textContent = isStaff()
      ? '你是审核角色，上传后会直接发布到表情广场。'
      : '普通用户上传后需要审核，通过后才会出现在表情广场。';

    const requested = location.hash.replace('#', '');
    const validRequested =
      VIEW_META[requested] && (requested !== 'review' || isStaff());
    setView(validRequested ? requested : 'square', { load: false, updateHash: false });
    loadCategories();
    if (state.view === 'square') loadSquare(true);
    if (state.view === 'mine') loadMine();
    if (state.view === 'review') loadReview();
    if (isStaff()) refreshReviewBadge();
  }

  function setView(view, { load = true, updateHash = true } = {}) {
    if (!VIEW_META[view]) return;
    if (view === 'review' && !isStaff()) return;

    state.view = view;
    const meta = VIEW_META[view];
    els.pageEyebrow.textContent = meta.eyebrow;
    els.pageTitle.textContent = meta.title;
    els.searchWrap.hidden = view !== 'square';
    document.title = `${meta.document} · 表情仓`;

    $$('.page').forEach((page) => {
      page.hidden = page.dataset.page !== view;
    });
    $$('.nav-item[data-view], .mobile-nav-item[data-view]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.view === view);
    });

    if (view === 'square') {
      els.searchInput.value = state.square.q;
    }
    if (updateHash) {
      history.replaceState(null, '', `#${view}`);
      window.scrollTo({ top: 0, behavior: 'auto' });
    }

    if (load) {
      if (view === 'square' && !state.square.loaded) loadSquare(true);
      if (view === 'mine') loadMine();
      if (view === 'review') loadReview();
    }
  }

  function resetWorkspaceState() {
    state.square.requestId += 1;
    state.square.controller?.abort();
    state.square.controller = null;
    state.square.items = [];
    state.square.total = 0;
    state.square.page = 1;
    state.square.q = '';
    state.square.category = '全部';
    state.square.sort = 'latest';
    state.square.loading = false;
    state.square.loaded = false;
    state.square.hasMore = false;
    state.mine = { items: [], loading: false };
    state.review = { items: [], total: 0, loading: false };
    state.categories = [];
    state.uploadFile = null;
    state.uploadFiles = [];
    state.rejectItem = null;
    els.searchInput.value = '';
    els.squareGrid.replaceChildren();
    els.mineGrid.replaceChildren();
    els.reviewList.replaceChildren();
    setReviewBadge(0);
    updateSortButtons();
  }

  function renderUser() {
    if (!state.user) return;
    els.userAvatar.textContent = Array.from(state.user.username)[0]?.toUpperCase() || 'U';
    els.userName.textContent = state.user.username;
    els.userRole.textContent = state.user.roleLabel;
    els.reviewRoleLabel.textContent = state.user.roleLabel;
  }

  function updateSortButtons() {
    els.sortButtons.forEach((button) => {
      button.classList.toggle('is-active', button.dataset.sort === state.square.sort);
    });
  }

  function makeStatusPill(status) {
    const meta = STATUS_META[status] || STATUS_META.pending;
    const pill = el('span', `status-pill ${meta.className}`);
    pill.append(icon(meta.icon), el('span', null, meta.label));
    return pill;
  }

  function createMedia(item, { showStatus = false } = {}) {
    const media = el('div', 'emoji-media');
    const img = el('img');
    img.src = item.imageUrl;
    img.alt = `${item.title} 表情`;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => {
      img.hidden = true;
      if (!media.querySelector('.media-fallback')) {
        media.append(el('span', 'media-fallback', '图片加载失败'));
      }
    });
    media.append(img);
    if (item.category) {
      media.append(el('span', 'media-tag', `# ${item.category}`));
    }
    if (showStatus) {
      const pill = makeStatusPill(item.status);
      pill.classList.add('media-status');
      media.append(pill);
    }
    return media;
  }

  function createDownloadCount(count) {
    const node = el('span', 'download-count');
    node.append(icon('download'), el('span', null, String(count)), el('span', null, '次下载'));
    return node;
  }

  function updateDownloadCount(button, item) {
    const card = button.closest('.emoji-card');
    const value = card?.querySelector('.download-count span:nth-of-type(1)');
    if (value) value.textContent = String(item.downloadCount);
  }

  function makeEmojiCard(item) {
    const card = el('article', 'emoji-card');
    card.dataset.id = String(item.id);
    card.append(createMedia(item));

    const body = el('div', 'emoji-body');
    const titleRow = el('div', 'emoji-title-row');
    const title = el('h3', 'emoji-title', item.title);
    title.title = item.title;
    titleRow.append(title);

    const meta = el('div', 'emoji-meta');
    meta.append(
      el('span', null, item.owner.username),
      el('span', 'meta-sep'),
      el('span', null, formatRelative(item.createdAt))
    );
    if (item.tags?.length) meta.append(el('span', 'meta-sep'), el('span', null, item.tags.map((tag) => `#${tag}`).join(' ')));

    const footer = el('div', 'emoji-footer');
    const count = createDownloadCount(item.downloadCount);
    const download = buttonWithIcon('btn btn-outline btn-mini', 'download', '下载');
    download.setAttribute('aria-label', `下载 ${item.title}`);
    download.addEventListener('click', () => downloadEmoji(item, download));

    const favorite = el('button', 'favorite-button', '♡');
    favorite.type = 'button';
    favorite.dataset.favoriteId = String(item.id);
    favorite.setAttribute('aria-label', `收藏 ${item.title}`);
    const selection = el('label', 'zip-select');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'zip-checkbox';
    checkbox.value = String(item.id);
    selection.append(checkbox, el('span', null, '打包'));
    footer.append(count, selection, favorite, download);
    body.append(titleRow, meta, footer);
    card.append(body);
    return card;
  }

  function makeMineCard(item) {
    const card = el('article', 'emoji-card');
    card.append(createMedia(item, { showStatus: true }));

    const body = el('div', 'emoji-body');
    const titleRow = el('div', 'emoji-title-row');
    const title = el('h3', 'emoji-title', item.title);
    title.title = item.title;
    titleRow.append(title);

    const meta = el('div', 'emoji-meta');
    meta.append(
      el('span', null, item.category),
      el('span', 'meta-sep'),
      el('span', null, `${item.width}×${item.height}`),
      el('span', 'meta-sep'),
      el('span', null, formatRelative(item.createdAt))
    );

    if (item.reviewNote) {
      body.append(titleRow, meta, el('p', 'review-note', `审核备注：${item.reviewNote}`));
    } else {
      body.append(titleRow, meta);
    }

    const footer = el('div', 'emoji-footer');
    const count = createDownloadCount(item.downloadCount);
    const actions = el('div', 'mine-actions');
    const download = iconOnlyButton(
      'btn btn-outline btn-mini btn-icon-only',
      'download',
      `下载 ${item.title}`
    );
    download.addEventListener('click', () => downloadEmoji(item, download));
    actions.append(download);

    if (item.status !== 'approved') {
      const remove = iconOnlyButton(
        'btn btn-ghost btn-mini btn-icon-only',
        'trash',
        `删除 ${item.title}`
      );
      remove.addEventListener('click', () => deleteOwnEmoji(item));
      actions.append(remove);
    }

    footer.append(count, actions);
    body.append(footer);
    card.append(body);
    return card;
  }

  function makeReviewCard(item) {
    const card = el('article', 'review-card');
    card.dataset.id = String(item.id);
    const selection = el('label', 'review-selection');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'review-checkbox';
    checkbox.value = String(item.id);
    selection.append(checkbox, el('span', null, '选择'));

    const thumb = el('div', 'review-thumb');
    const img = el('img');
    img.src = item.imageUrl;
    img.alt = item.title;
    img.loading = 'lazy';
    thumb.append(img);

    const info = el('div', 'review-info');
    const titleRow = el('div', 'review-title-row');
    const title = el('h3', null, item.title);
    title.title = item.title;
    titleRow.append(title, makeStatusPill('pending'));

    const meta = el('div', 'review-meta');
    const category = el('span');
    category.append(icon('folder'), el('span', null, item.category));
    const owner = el('span');
    owner.append(icon('user'), el('span', null, `上传者 ${item.owner.username}`));
    const time = el('span');
    time.title = formatFullDate(item.createdAt);
    time.append(icon('clock'), el('span', null, formatRelative(item.createdAt)));
    const size = el('span');
    size.append(
      icon('image'),
      el('span', null, `${item.width}×${item.height} · ${formatBytes(item.sizeBytes)}`)
    );
    meta.append(category, owner, time, size);

    info.append(titleRow, meta);

    const actions = el('div', 'review-actions');
    const approve = buttonWithIcon('btn btn-primary', 'check', '通过');
    approve.dataset.approve = String(item.id);
    approve.setAttribute('aria-label', `通过 ${item.title}`);
    const reject = buttonWithIcon('btn btn-ghost', 'x', '驳回');
    reject.dataset.reject = String(item.id);
    reject.setAttribute('aria-label', `驳回 ${item.title}`);
    actions.append(approve, reject);

    card.append(selection, thumb, info, actions);
    return card;
  }

  function createSkeletons(container, count = 8) {
    container.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < count; index += 1) {
      const card = el('div', 'skeleton-card');
      const media = el('div', 'skeleton-media');
      const line = el('div', 'skeleton-line');
      const shortLine = el('div', 'skeleton-line short');
      card.append(media, line, shortLine);
      fragment.append(card);
    }
    container.append(fragment);
  }

  function renderCategories() {
    const total = state.categories.reduce((sum, category) => sum + category.count, 0);
    if (
      state.square.category !== '全部' &&
      !state.categories.some((category) => category.name === state.square.category)
    ) {
      state.square.category = '全部';
    }

    const fragment = document.createDocumentFragment();
    const all = makeCategoryChip('全部', total);
    fragment.append(all);
    for (const category of state.categories) {
      fragment.append(makeCategoryChip(category.name, category.count));
    }
    els.categoryRow.replaceChildren(fragment);
    updateCategoryOptions();
  }

  function makeCategoryChip(name, count) {
    const chip = el('button', 'category-chip');
    chip.type = 'button';
    chip.dataset.category = name;
    chip.classList.toggle('is-active', state.square.category === name);
    chip.setAttribute('aria-pressed', String(state.square.category === name));
    chip.append(el('span', null, name), el('span', 'category-count', String(count)));
    return chip;
  }

  function updateCategoryOptions() {
    const names = new Set([...DEFAULT_CATEGORIES, ...state.categories.map((item) => item.name)]);
    const fragment = document.createDocumentFragment();
    for (const name of names) {
      const option = document.createElement('option');
      option.value = name;
      fragment.append(option);
    }
    els.categoryOptions.replaceChildren(fragment);
  }

  async function loadCategories() {
    try {
      const data = await api('/api/categories');
      state.categories = data.items;
      renderCategories();
    } catch (error) {
      if (error.status !== 401) {
        els.categoryRow.replaceChildren(el('span', 'loading-chip', '分类加载失败'));
      }
    }
  }

  function updateSquareResult() {
    const square = state.square;
    if (square.total === 0) {
      els.resultLine.textContent = square.q
        ? `没有找到与“${square.q}”相关的表情`
        : '暂时还没有可展示的表情';
      return;
    }
    const sortLabel = square.sort === 'popular' ? '按下载热度排序' : '按最新发布排序';
    if (square.q) {
      els.resultLine.textContent = `“${square.q}” · 找到 ${square.total} 张表情 · ${sortLabel}`;
    } else if (square.category !== '全部') {
      els.resultLine.textContent = `${square.category} · 共 ${square.total} 张表情 · ${sortLabel}`;
    } else {
      els.resultLine.textContent = `共 ${square.total} 张表情 · ${sortLabel}`;
    }
  }

  function updateEmptySquare() {
    const filtered = Boolean(state.square.q) || state.square.category !== '全部';
    els.squareEmptyText.textContent = filtered
      ? '换个关键词或分类试试，也可能它还在审核路上。'
      : '还没有通过审核的表情，上传第一张来热热场子。';
  }

  function updateLoadMore() {
    const square = state.square;
    const visible = square.items.length > 0 && square.items.length < square.total;
    els.loadMoreWrap.hidden = !visible;
    els.loadMoreBtn.disabled = square.loading;
    els.loadMoreBtn.textContent = square.loading ? '翻找中…' : '再看一些';
  }

  function renderSquare(reset) {
    const square = state.square;
    if (reset) els.squareGrid.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const item of reset ? square.items : square.items.slice(els.squareGrid.children.length)) {
      fragment.append(makeEmojiCard(item));
    }
    els.squareGrid.append(fragment);
    els.squareGrid.hidden = square.items.length === 0;
    els.squareEmpty.hidden = square.items.length !== 0;
    els.squareGrid.setAttribute('aria-busy', 'false');
    updateEmptySquare();
    updateSquareResult();
    updateLoadMore();
  }

  async function loadSquare(reset = true) {
    const square = state.square;
    if (!reset && (square.loading || !square.hasMore)) return;

    square.controller?.abort();
    const controller = new AbortController();
    square.controller = controller;
    const requestId = ++square.requestId;
    square.loading = true;

    if (reset) {
      square.page = 1;
      square.items = [];
      square.total = 0;
      els.squareEmpty.hidden = true;
      els.squareGrid.hidden = false;
      els.squareGrid.setAttribute('aria-busy', 'true');
      createSkeletons(els.squareGrid, 8);
      els.resultLine.textContent = '正在翻找表情仓…';
      els.loadMoreWrap.hidden = true;
    } else {
      els.loadMoreBtn.disabled = true;
      els.loadMoreBtn.textContent = '翻找中…';
    }

    const page = reset ? 1 : square.page + 1;
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(square.pageSize),
      sort: square.sort,
    });
    if (square.q) params.set('q', square.q);
    if (square.category !== '全部') params.set('category', square.category);

    try {
      const data = await api(`/api/emojis?${params.toString()}`, { signal: controller.signal });
      if (requestId !== square.requestId) return;
      square.items = reset ? data.items : square.items.concat(data.items);
      square.total = data.total;
      square.page = page;
      square.hasMore = square.items.length < data.total;
      square.loaded = true;
      renderSquare(reset);
    } catch (error) {
      if (error.name === 'AbortError' || requestId !== square.requestId) return;
      square.loaded = true;
      if (reset) {
        square.items = [];
        square.total = 0;
        els.squareGrid.replaceChildren();
        els.squareGrid.hidden = true;
        els.squareEmpty.hidden = false;
        els.squareEmptyText.textContent = '表情加载失败，请稍后刷新页面再试。';
        els.resultLine.textContent = '加载失败';
        els.loadMoreWrap.hidden = true;
      } else {
        updateLoadMore();
      }
      if (error.status !== 401) toast(error.message || '加载表情失败', 'error');
    } finally {
      if (requestId === square.requestId) {
        square.loading = false;
        square.controller = null;
        updateLoadMore();
      }
    }
  }

  function updateMineStats() {
    const counts = { approved: 0, pending: 0, rejected: 0 };
    for (const item of state.mine.items) {
      if (counts[item.status] !== undefined) counts[item.status] += 1;
    }
    const totalNode = $('.stat-total strong');
    const approvedNode = $('.stat-approved strong');
    const pendingNode = $('.stat-pending strong');
    const rejectedNode = $('.stat-rejected strong');
    if (totalNode) totalNode.textContent = String(state.mine.items.length);
    if (approvedNode) approvedNode.textContent = String(counts.approved);
    if (pendingNode) pendingNode.textContent = String(counts.pending);
    if (rejectedNode) rejectedNode.textContent = String(counts.rejected);
    els.mineCount.textContent = `${state.mine.items.length} 张`;
  }

  function renderMine() {
    els.mineGrid.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const item of state.mine.items) {
      fragment.append(makeMineCard(item));
    }
    els.mineGrid.append(fragment);
    els.mineGrid.hidden = state.mine.items.length === 0;
    els.mineEmpty.hidden = state.mine.items.length !== 0;
    updateMineStats();
  }

  async function loadMine() {
    if (state.mine.loading) return;
    state.mine.loading = true;
    try {
      const data = await api('/api/emojis/mine');
      state.mine.items = data.items;
      renderMine();
    } catch (error) {
      if (error.status !== 401) toast(error.message || '加载我的上传失败', 'error');
    } finally {
      state.mine.loading = false;
    }
  }

  function setReviewBadge(total) {
    const text = total > 99 ? '99+' : String(total);
    for (const node of [els.reviewBadge, els.mobileReviewBadge]) {
      node.textContent = text;
      node.hidden = total <= 0;
    }
  }

  async function refreshReviewBadge() {
    if (!isStaff()) {
      setReviewBadge(0);
      return;
    }
    try {
      const data = await api('/api/review/count');
      setReviewBadge(data.total);
    } catch (error) {
      if (error.status !== 401) console.error('加载审核数量失败', error);
    }
  }

  function renderReview() {
    els.reviewList.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const item of state.review.items) {
      fragment.append(makeReviewCard(item));
    }
    els.reviewList.append(fragment);
    els.reviewList.hidden = state.review.items.length === 0;
    els.reviewEmpty.hidden = state.review.items.length !== 0;
    els.reviewCount.textContent = String(state.review.total);
    els.reviewSummary.textContent =
      state.review.total > 0
        ? `还有 ${state.review.total} 张表情等待审核`
        : '审核队列已清空';
    setReviewBadge(state.review.total);
  }

  async function loadReview() {
    if (!isStaff()) return;
    if (state.review.loading) return;
    state.review.loading = true;
    try {
      const data = await api('/api/review/queue');
      state.review.items = data.items;
      state.review.total = data.total;
      renderReview();
    } catch (error) {
      if (error.status !== 401) toast(error.message || '加载审核队列失败', 'error');
    } finally {
      state.review.loading = false;
    }
  }

  async function refreshAfterReview() {
    await Promise.all([
      loadReview(),
      loadCategories(),
      state.square.loaded ? loadSquare(true) : Promise.resolve(),
    ]);
  }

  async function batchReview(decision) {
    const ids = $$('.review-checkbox:checked', els.reviewList).map((box) => Number(box.value));
    if (!ids.length) return toast('请先选择待审核表情', 'error');
    let note = '';
    if (decision === 'rejected') {
      const answer = window.prompt(`请输入这 ${ids.length} 张表情的驳回原因（可留空）`, '');
      if (answer === null) return;
      note = answer.slice(0, 200);
    }
    try {
      const result = await api('/api/review/batch', { method: 'POST', body: { ids, decision, note } });
      toast(`已处理 ${result.count} 张表情`);
      byId('review-select-all').checked = false;
      await refreshAfterReview();
    } catch (error) {
      if (error.status !== 401) toast(error.message || '批量审核失败', 'error');
    }
  }

  async function approveReview(item, button) {
    if (!button || button.disabled) return;
    setButtonBusy(button, true, '通过', '处理中…');
    try {
      await api(`/api/emojis/${item.id}/review`, {
        method: 'POST',
        body: { decision: 'approved' },
      });
      toast(`《${item.title}》已发布到表情广场`);
      await refreshAfterReview();
    } catch (error) {
      if (error.status !== 401) toast(error.message || '审核失败', 'error');
    } finally {
      if (button.isConnected) setButtonBusy(button, false, '通过', '处理中…');
    }
  }

  function openRejectDialog(item) {
    state.rejectItem = item;
    els.rejectTarget.textContent = `《${item.title}》 · 上传者 ${item.owner.username}`;
    els.rejectNote.value = '';
    setFormError(els.rejectError, '');
    if (!els.rejectDialog.open) els.rejectDialog.showModal();
    window.setTimeout(() => els.rejectNote.focus(), 40);
  }

  async function rejectReview(event) {
    event.preventDefault();
    if (!state.rejectItem || state.rejectBusy) return;
    state.rejectBusy = true;
    setFormError(els.rejectError, '');
    setButtonBusy(els.rejectSubmit, true, '确认驳回', '正在驳回…');
    try {
      await api(`/api/emojis/${state.rejectItem.id}/review`, {
        method: 'POST',
        body: {
          decision: 'rejected',
          note: els.rejectNote.value.trim(),
        },
      });
      const title = state.rejectItem.title;
      state.rejectItem = null;
      els.rejectDialog.close();
      toast(`《${title}》已驳回`, 'success');
      await refreshAfterReview();
    } catch (error) {
      if (error.status !== 401) setFormError(els.rejectError, error.message || '驳回失败');
    } finally {
      state.rejectBusy = false;
      setButtonBusy(els.rejectSubmit, false, '确认驳回', '正在驳回…');
    }
  }

  async function downloadEmoji(item, button) {
    if (!button || button.disabled) return;
    setButtonBusy(button, true, '下载', '准备中…');
    try {
      const response = await fetch(item.downloadUrl, { credentials: 'same-origin' });
      if (!response.ok) {
        let message = '下载失败，请稍后再试';
        try {
          const payload = await response.json();
          message = payload?.error?.message || message;
        } catch {
          // Keep the fallback message.
        }
        if (response.status === 401) handleSessionExpired();
        throw new Error(message);
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      let filename = `${item.title}${extensionForMime(item.mimeType)}`;
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
      const plain = /filename="([^"]+)"/i.exec(disposition);
      if (encoded) {
        try {
          filename = decodeURIComponent(encoded[1]);
        } catch {
          // Keep generated filename.
        }
      } else if (plain) {
        filename = plain[1];
      }
      filename = filename.replace(/[\\/:*?"<>|]/g, '_');

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1200);

      item.downloadCount += 1;
      updateDownloadCount(button, item);
      toast('已开始下载');
    } catch (error) {
      if (error.name !== 'AbortError') toast(error.message || '下载失败', 'error');
    } finally {
      if (button.isConnected) setButtonBusy(button, false, '下载', '准备中…');
    }
  }

  async function deleteOwnEmoji(item) {
    const confirmed = window.confirm(`确定删除《${item.title}》吗？删除后可联系管理员恢复。`);
    if (!confirmed) return;
    try {
      await api(`/api/emojis/${item.id}`, { method: 'DELETE' });
      state.mine.items = state.mine.items.filter((entry) => entry.id !== item.id);
      renderMine();
      toast(`《${item.title}》已删除`);
    } catch (error) {
      if (error.status !== 401) toast(error.message || '删除失败', 'error');
    }
  }

  function openUploadDialog() {
    if (!state.user) return;
    resetUploadForm();
    if (state.square.category !== '全部') {
      els.uploadCategory.value = state.square.category;
    }
    els.uploadNoteText.textContent = isStaff()
      ? '你是审核角色，上传后会直接发布到表情广场。'
      : '普通用户上传后需要审核，通过后才会出现在表情广场。';
    if (!els.uploadDialog.open) els.uploadDialog.showModal();
    window.setTimeout(() => els.dropZone.focus(), 30);
  }

  function resetUploadForm() {
    if (state.uploadPreviewUrl) {
      URL.revokeObjectURL(state.uploadPreviewUrl);
      state.uploadPreviewUrl = null;
    }
    state.uploadFile = null;
    state.uploadFiles = [];
    els.uploadForm.reset();
    els.fileInput.value = '';
    els.previewImg.removeAttribute('src');
    els.dropPreview.hidden = true;
    els.dropEmpty.hidden = false;
    els.dropZone.classList.remove('is-dragover');
    setFormError(els.uploadError, '');
    updateUploadSubmitState();
  }

  function updateUploadSubmitState() {
    els.uploadSubmit.disabled = state.uploadBusy || !state.uploadFiles.length;
    const span = els.uploadSubmit.querySelector('span');
    if (span) span.textContent = state.uploadBusy ? '正在上传…' : '上传并提交';
  }

  function setUploadFiles(inputFiles) {
    const files = Array.from(inputFiles || []);
    if (!files.length) return;
    setFormError(els.uploadError, '');
    if (files.length > 10) return setFormError(els.uploadError, '每次最多选择 10 张图片');
    for (const file of files) {
      const typeOk = ALLOWED_TYPES.has(file.type) || (!file.type && ALLOWED_EXTENSIONS.test(file.name));
      if (!typeOk) return setFormError(els.uploadError, `${file.name} 不是支持的图片格式`);
      if (file.size > MAX_FILE_BYTES) return setFormError(els.uploadError, `${file.name} 超过 5 MB`);
    }
    const file = files[0];
    if (state.uploadPreviewUrl) URL.revokeObjectURL(state.uploadPreviewUrl);
    state.uploadFile = file;
    state.uploadFiles = files;
    state.uploadPreviewUrl = URL.createObjectURL(file);
    els.previewImg.src = state.uploadPreviewUrl;
    els.previewName.textContent = files.length === 1 ? file.name : `${file.name} 等 ${files.length} 张图片`;
    els.previewMeta.textContent = files.length === 1
      ? `${formatBytes(file.size)} · ${file.type || '图片'}`
      : `共 ${formatBytes(files.reduce((sum, item) => sum + item.size, 0))}`;
    els.dropEmpty.hidden = true;
    els.dropPreview.hidden = false;
    updateUploadSubmitState();
  }

  async function prepareImage(file) {
    try {
      const bitmap = await createImageBitmap(file);
      const makeBlob = (max, quality) => new Promise((resolve) => {
        const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(resolve, 'image/webp', quality);
      });
      const thumbnail = await makeBlob(320, 0.72);
      const compressed = file.type === 'image/gif' ? null : await makeBlob(2048, 0.82);
      bitmap.close();
      const upload = compressed && compressed.size < file.size * 0.9
        ? new File([compressed], file.name.replace(/\.[^.]+$/, '.webp'), { type: 'image/webp' }) : file;
      return { upload, thumbnail };
    } catch {
      return { upload: file, thumbnail: null };
    }
  }

  async function submitUpload(event) {
    event.preventDefault();
    if (state.uploadBusy) return;
    if (!state.uploadFiles.length) {
      setFormError(els.uploadError, '请先选择图片');
      return;
    }

    state.uploadBusy = true;
    updateUploadSubmitState();
    setFormError(els.uploadError, '');
    const formData = new FormData();
    const prepared = await Promise.all(state.uploadFiles.map(prepareImage));
    for (const item of prepared) formData.append('file', item.upload, item.upload.name);
    if (prepared.every((item) => item.thumbnail)) {
      for (const item of prepared) formData.append('thumbnail', item.thumbnail, 'thumbnail.webp');
    }
    if (prepared.length === 1 && els.uploadTitleInput.value.trim()) {
      formData.append('title', els.uploadTitleInput.value.trim());
    }
    if (els.uploadCategory.value.trim()) {
      formData.append('category', els.uploadCategory.value.trim());
    }
    if (els.uploadTags.value.trim()) formData.append('tags', els.uploadTags.value.trim());

    try {
      const data = await api('/api/emojis', { method: 'POST', body: formData });
      els.uploadDialog.close();
      toast(data.message || '上传成功');
      await loadCategories();
      if (data.emoji.status === 'pending') {
        setView('mine', { load: false });
        await loadMine();
      } else {
        await loadSquare(true);
        if (state.view === 'mine') await loadMine();
        if (state.view === 'review') await loadReview();
      }
      if (isStaff()) refreshReviewBadge();
    } catch (error) {
      if (error.status !== 401) {
        setFormError(els.uploadError, error.message || '上传失败，请稍后再试');
      }
    } finally {
      state.uploadBusy = false;
      updateUploadSubmitState();
    }
  }

  function closeDialogs() {
    if (els.uploadDialog.open) els.uploadDialog.close();
    if (els.rejectDialog.open) els.rejectDialog.close();
  }

  function bindEvents() {
    document.addEventListener('click', (event) => {
      const viewButton = event.target.closest('[data-view]');
      if (viewButton) {
        setView(viewButton.dataset.view);
        return;
      }

      if (event.target.closest('[data-open-upload]')) {
        openUploadDialog();
        return;
      }

      if (event.target.closest('[data-go-square]')) {
        setView('square');
        return;
      }

      if (event.target.closest('[data-close-dialog]')) {
        if (!state.uploadBusy) els.uploadDialog.close();
        return;
      }

      if (event.target.closest('[data-close-reject]')) {
        if (!state.rejectBusy) els.rejectDialog.close();
        return;
      }

      const authTab = event.target.closest('[data-auth-tab]');
      if (authTab) {
        switchAuthMode(authTab.dataset.authTab);
        return;
      }

      const authSwitch = event.target.closest('[data-auth-switch]');
      if (authSwitch) {
        switchAuthMode(authSwitch.dataset.authSwitch);
        return;
      }

      const category = event.target.closest('[data-category]');
      if (category) {
        state.square.category = category.dataset.category;
        $$('[data-category]').forEach((chip) => {
          const active = chip.dataset.category === state.square.category;
          chip.classList.toggle('is-active', active);
          chip.setAttribute('aria-pressed', String(active));
        });
        loadSquare(true);
        return;
      }

      const sort = event.target.closest('[data-sort]');
      if (sort) {
        state.square.sort = sort.dataset.sort === 'popular' ? 'popular' : 'latest';
        updateSortButtons();
        loadSquare(true);
      }
    });

    els.authForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state.authBusy) return;

      const username = els.authUsername.value.trim();
      const password = els.authPassword.value;
      const register = state.authMode === 'register';

      if (!username) {
        setFormError(els.authError, '请输入用户名');
        els.authUsername.focus();
        return;
      }
      if (password.length < 8) {
        setFormError(els.authError, '密码至少需要 8 位');
        els.authPassword.focus();
        return;
      }
      if (register && password !== els.authConfirm.value) {
        setFormError(els.authError, '两次输入的密码不一致');
        els.authConfirm.focus();
        return;
      }

      setFormError(els.authError, '');
      setAuthBusy(true);
      try {
        const payload = await api(`/api/auth/${register ? 'register' : 'login'}`, {
          method: 'POST',
          body: { username, password },
        });
        els.authForm.reset();
        enterApp(payload.user);
        toast(register ? '账号创建成功，欢迎加入表情仓' : `欢迎回来，${payload.user.username}`);
      } catch (error) {
        setFormError(els.authError, error.message || '操作失败，请稍后再试');
      } finally {
        setAuthBusy(false);
      }
    });

    els.logoutBtn.addEventListener('click', async () => {
      els.logoutBtn.disabled = true;
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } catch (error) {
        if (error.status !== 401) toast(error.message || '退出登录失败', 'error');
      } finally {
        els.logoutBtn.disabled = false;
        showAuth('login');
        toast('已退出登录');
      }
    });

    let searchTimer = null;
    els.searchInput.addEventListener('input', () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        const value = els.searchInput.value.trim();
        if (value === state.square.q) return;
        if (state.view !== 'square') setView('square', { load: false });
        state.square.q = value;
        loadSquare(true);
      }, 280);
    });

    els.loadMoreBtn.addEventListener('click', () => loadSquare(false));

    els.reviewList.addEventListener('click', (event) => {
      const approveButton = event.target.closest('[data-approve]');
      if (approveButton) {
        const item = state.review.items.find(
          (entry) => String(entry.id) === approveButton.dataset.approve
        );
        if (item) approveReview(item, approveButton);
        return;
      }
      const rejectButton = event.target.closest('[data-reject]');
      if (rejectButton) {
        const item = state.review.items.find(
          (entry) => String(entry.id) === rejectButton.dataset.reject
        );
        if (item) openRejectDialog(item);
      }
    });
    byId('review-select-all').addEventListener('change', (event) => {
      $$('.review-checkbox', els.reviewList).forEach((box) => { box.checked = event.target.checked; });
    });
    byId('batch-approve').addEventListener('click', () => batchReview('approved'));
    byId('batch-reject').addEventListener('click', () => batchReview('rejected'));

    els.rejectForm.addEventListener('submit', rejectReview);

    els.dropZone.addEventListener('click', (event) => {
      if (event.target.closest('#remove-file')) return;
      els.fileInput.click();
    });

    els.dropZone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        els.fileInput.click();
      }
    });

    for (const eventName of ['dragenter', 'dragover']) {
      els.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
        els.dropZone.classList.add('is-dragover');
      });
    }

    els.dropZone.addEventListener('dragleave', (event) => {
      event.preventDefault();
      if (!els.dropZone.contains(event.relatedTarget)) {
        els.dropZone.classList.remove('is-dragover');
      }
    });

    els.dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      els.dropZone.classList.remove('is-dragover');
      const files = event.dataTransfer?.files;
      if (files?.length) setUploadFiles(files);
    });

    els.fileInput.addEventListener('change', () => {
      const files = els.fileInput.files;
      if (files?.length) setUploadFiles(files);
    });

    els.removeFile.addEventListener('click', (event) => {
      event.stopPropagation();
      resetUploadForm();
    });

    els.uploadForm.addEventListener('submit', submitUpload);

    els.uploadDialog.addEventListener('cancel', (event) => {
      if (state.uploadBusy) event.preventDefault();
    });
    els.rejectDialog.addEventListener('cancel', (event) => {
      if (state.rejectBusy) event.preventDefault();
    });

    els.uploadDialog.addEventListener('close', resetUploadForm);
    els.rejectDialog.addEventListener('close', () => {
      state.rejectItem = null;
      state.rejectBusy = false;
      els.rejectNote.value = '';
      setFormError(els.rejectError, '');
    });

    for (const dialog of [els.uploadDialog, els.rejectDialog]) {
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        if (dialog === els.uploadDialog && state.uploadBusy) return;
        if (dialog === els.rejectDialog && state.rejectBusy) return;
        dialog.close();
      });
    }
  }

  async function restoreSession() {
    try {
      const payload = await api('/api/auth/me');
      enterApp(payload.user);
    } catch (error) {
      if (error.status && error.status !== 401) {
        showAuth('login', '暂时无法连接服务，请确认服务器已经启动。');
      } else {
        showAuth('login');
      }
    }
  }

  function init() {
    bindEvents();
    switchAuthMode('login');
    updateSortButtons();
    restoreSession();
  }

  init();
})();
