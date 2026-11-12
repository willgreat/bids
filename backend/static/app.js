'use strict';

const API = '/mgmt/bids/api';
const main = document.querySelector('#main');
const drawerRoot = document.querySelector('#drawer-root');
const editor = document.querySelector('#editor-dialog');
const projectActionDialog = document.querySelector('#project-action-dialog');
const pendingProjectActions = new Set();
const decisions = ['待评估', '参与', '暂缓', '放弃'];
const receipts = ['未领取', '已申请', '已领取', '已截止'];
const stages = ['线索', '领件', '评估', '制标', '已递交', '成交', '未成交', '已结束'];
const caStatuses = ['未办理', '办理中', '有效', '补办中', '已过期', '待确认'];
const state = {
  view: 'projects', data: { projects: [], cas: [], activity: [] },
  query: '', platform: '', stage: '', decision: '', quick: 'all', page: 1,
  selected: null, detailTab: 'overview', discoverQuery: '软件开发 音视频 RTC 智能客服',
  discovery: null, discovering: false, editing: null, saving: false, materialSaving: false,
  expired: { query: '', platform: '', stage: '', decision: '', reason: '', quick: 'all', page: 1 },
  discarded: { query: '', platform: '', stage: '', decision: '', quick: 'all', page: 1 },
  scroll: {}, calendarHistory: false, upload: null,
  month: new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).getMonth(),
  year: new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).getFullYear()
};
let toastTimer;
let drawerTrigger = null;
let projectActionTrigger = null;
let editorInitial = '';
const viewNames = { projects: '项目台账', expired: '已过期', discarded: '已弃标', calendar: '截止日历', cas: 'CA 证书', discover: '发现新项目', activity: '操作记录' };

function saveViewState() {
  try {
    const { view, query, platform, stage, decision, quick, page, expired, discarded, scroll, calendarHistory } = state;
    sessionStorage.setItem('yyyl-bids-view-v2', JSON.stringify({ view, query, platform, stage, decision, quick, page, expired, discarded, scroll, calendarHistory }));
  } catch (_) {}
}

function restoreViewState() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('yyyl-bids-view-v2') || 'null');
    if (!saved || !viewNames[saved.view]) return;
    state.view = saved.view;
    for (const key of ['query', 'platform', 'stage', 'decision', 'quick']) if (typeof saved[key] === 'string') state[key] = saved[key];
    if (Number.isInteger(saved.page) && saved.page > 0) state.page = saved.page;
    if (saved.expired && typeof saved.expired === 'object') {
      for (const key of ['query', 'platform', 'stage', 'decision', 'reason']) if (typeof saved.expired[key] === 'string') state.expired[key] = saved.expired[key];
      if (Number.isInteger(saved.expired.page) && saved.expired.page > 0) state.expired.page = saved.expired.page;
    }
    if (saved.discarded && typeof saved.discarded === 'object') {
      for (const key of ['query', 'platform', 'stage']) if (typeof saved.discarded[key] === 'string') state.discarded[key] = saved.discarded[key];
      if (Number.isInteger(saved.discarded.page) && saved.discarded.page > 0) state.discarded.page = saved.discarded.page;
    }
    // Earlier versions allowed the abandoned decision in the default lists.
    if (state.decision === '放弃') state.decision = '';
    if (state.expired.decision === '放弃') state.expired.decision = '';
    if (saved.scroll && typeof saved.scroll === 'object') state.scroll = saved.scroll;
    state.calendarHistory = saved.calendarHistory === true;
  } catch (_) {}
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function url(value) {
  try {
    if (!/^https?:\/\//i.test(String(value))) return '';
    const parsed = new URL(value, location.origin);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch (_) { return ''; }
}

function externalLink(value, label) {
  const safe = value && url(value);
  return safe ? `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(label || value)} ↗</a>` : '<span class="muted">待补充</span>';
}

function parseTime(value) {
  if (!value) return NaN;
  const input = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T00:00:00+08:00`
    : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(input) ? `${input.replace(' ', 'T')}+08:00` : input;
  return new Date(normalized).getTime();
}

function dayKey(value = Date.now()) {
  const time = typeof value === 'number' ? value : parseTime(value);
  if (!Number.isFinite(time)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(time);
  return ['year', 'month', 'day'].map(k => parts.find(p => p.type === k).value).join('-');
}

function formatTime(value, full = false) {
  const time = parseTime(value);
  if (!Number.isFinite(time)) return '待确认';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(value));
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', ...(full ? { year: 'numeric' } : {}), month: '2-digit', day: '2-digit',
    ...(!dateOnly ? { hour: '2-digit', minute: '2-digit', hour12: false } : {})
  }).format(time);
}

function money(value) {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) return '未披露';
  const amount = Number(value);
  return amount >= 10000 ? `¥ ${(amount / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 万` : `¥ ${amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
}

function budgetTaxLabel(project) {
  if (project.budget === null || project.budget === undefined || project.budget === '') return '';
  const labels = { '未披露': '税口径待核实', '待确认': '税口径待确认' };
  return labels[project.budget_tax] || project.budget_tax || '税口径待核实';
}

function sizeLabel(value) {
  const n = Number(value) || 0;
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function badge(value, group = '') {
  let tone = 'gray';
  if (['参与', '已领取', '成交', '有效'].includes(value)) tone = 'teal';
  if (['制标', '已递交', '已申请', '办理中', '领件'].includes(value)) tone = 'blue';
  if (['待评估', '暂缓', '待确认', '补办中', '评估'].includes(value)) tone = 'amber';
  if (['未办理', '已过期'].includes(value)) tone = 'red';
  return `<span class="badge ${tone}">${esc(value === '放弃' ? '已弃标' : value || (group === 'ca' ? '待确认' : '未设置'))}</span>`;
}

function pinBadge(project) {
  return project.pinned === true ? '<span class="pin-badge"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 3 6 0-1 5 3 3v2H5v-2l3-3-1-5ZM10 13v4"/></svg>已置顶</span>' : '';
}

function projectActionButtons(project) {
  const busy = pendingProjectActions.has(project.id);
  const attrs = `data-project-id="${esc(project.id)}"${busy ? ' disabled aria-busy="true"' : ''}`;
  return `<button class="text-button project-pin-action${project.pinned === true ? ' is-pinned' : ''}" data-action="toggle-pin" ${attrs} aria-pressed="${project.pinned === true}" aria-label="${project.pinned === true ? '取消置顶' : '置顶'}${esc(project.title)}">${project.pinned === true ? '取消置顶' : '置顶'}</button>`
    + (discarded(project)
      ? `<button class="text-button" data-action="restore-project" ${attrs} aria-label="恢复跟进${esc(project.title)}">恢复跟进</button>`
      : `<button class="text-button project-discard-action" data-action="discard-project" ${attrs} aria-label="弃标${esc(project.title)}">弃标</button>`);
}

function closeProjectActionDialog() {
  if (projectActionDialog.open) projectActionDialog.close();
  if (projectActionTrigger?.isConnected) projectActionTrigger.focus({ preventScroll: true });
  projectActionTrigger = null;
}

function confirmDiscardProject(id, trigger) {
  const p = projectById(id);
  if (!p || discarded(p) || pendingProjectActions.has(id) || editor.open || projectActionDialog.open) return;
  projectActionTrigger = trigger;
  projectActionDialog.className = 'editor-dialog project-action-dialog';
  projectActionDialog.innerHTML = `<div class="editor-header"><h2 id="project-action-title">确认弃标</h2><button class="icon-btn" data-action="cancel-discard" aria-label="关闭弃标确认">×</button></div><div class="editor-body"><p class="discard-project-name">${esc(p.title)}</p><p id="project-action-description">弃标后将从项目台账、已过期与日历中隐藏。采购文件和跟进记录保存在“已弃标”，可随时恢复。</p></div><div class="editor-footer"><button class="btn" data-action="cancel-discard">继续跟进</button><button class="btn btn-primary" data-action="confirm-discard" data-project-id="${esc(id)}">确认弃标</button></div>`;
  projectActionDialog.showModal();
  projectActionDialog.querySelector('[data-action="cancel-discard"]')?.focus();
}

async function changeProjectAction(id, action) {
  const p = projectById(id);
  if (!p || pendingProjectActions.has(id) || state.upload?.active && state.upload.projectId === id) {
    if (state.upload?.active && state.upload.projectId === id) toast('文件正在上传，完成后再操作。', true);
    return;
  }
  const changes = action === 'pin' ? { pinned: p.pinned !== true } : { decision: action === 'discard' ? '放弃' : '待评估' };
  pendingProjectActions.add(id);
  document.querySelectorAll('[data-project-id]').forEach(node => { if (node.dataset.projectId === id) node.disabled = true; });
  try {
    const saved = await api(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ version: p.version, ...changes }) });
    pendingProjectActions.delete(id);
    const index = state.data.projects.findIndex(item => item.id === saved.id);
    if (index >= 0) state.data.projects[index] = saved;
    if (action !== 'pin' && state.selected === id) closeDrawer();
    if (action === 'pin') listFilters().page = 1;
    const scroll = window.scrollY;
    render();
    if (action === 'pin' && ['projects', 'expired', 'discarded'].includes(state.view)) renderProjectResults(true);
    if (state.selected) renderDrawer();
    window.scrollTo(0, scroll);
    toast(action === 'pin' ? saved.pinned ? '项目已置顶' : '已取消置顶'
      : action === 'discard' ? '已弃标，可在“已弃标”中恢复'
      : projectStatus(saved).archived ? '已恢复跟进，可在“已过期”中查看' : '已恢复到项目台账');
  } catch (error) {
    toast(error.message, true);
  } finally {
    pendingProjectActions.delete(id);
    document.querySelectorAll('[data-project-id]').forEach(node => { if (node.dataset.projectId === id) { node.disabled = false; node.removeAttribute('aria-busy'); } });
  }
}

function projectById(id) { return state.data.projects.find(p => String(p.id) === String(id)); }
function caById(id) { return state.data.cas.find(c => String(c.id) === String(id)); }
function deadlineKind(deadline) {
  const type = String(deadline.type || '').toLowerCase();
  if (['receipt', 'registration', '领件', '报名'].includes(type)) return 'receipt';
  if (['submission', '递交', '响应', '投标'].includes(type)) return 'submission';
  if (/响应截止|递交截止|投标截止|纸件送达截止|现场响应/.test(deadline.label || '')) return 'submission';
  if (/领件|领取|报名/.test(deadline.label || '')) return 'receipt';
  return type || 'other';
}
function dateOnly(deadline) { return deadline.date_only === true || /^\d{4}-\d{2}-\d{2}$/.test(String(deadline.at)); }
function deadlineTime(deadline) {
  const time = parseTime(deadline?.at);
  return Number.isFinite(time) && dateOnly(deadline) ? parseTime(dayKey(time)) + 86400000 : time;
}
function deadlinePassed(deadline, time = Date.now()) { return Number.isFinite(deadlineTime(deadline)) && deadlineTime(deadline) <= time; }
function formatDeadline(deadline, full = false) {
  if (!Number.isFinite(parseTime(deadline?.at))) return '截止时间待确认';
  return dateOnly(deadline) ? formatTime(dayKey(deadline.at), full) + ' · 时刻待确认' : formatTime(deadline.at, full);
}
function validDeadlines(project) { return (project.deadlines || []).filter(d => d.is_current !== false && Number.isFinite(parseTime(d.at))); }
function deadlinesOf(project, kind) { return validDeadlines(project).filter(d => deadlineKind(d) === kind).sort((a, b) => deadlineTime(a) - deadlineTime(b)); }
function projectStatus(project, time = Date.now()) {
  if (['成交', '未成交', '已结束'].includes(project.stage)) return { archived: true, reason: 'ended', label: project.decision === '放弃' ? '已结束跟进' : '采购已结束', at: project.updated_at || '', deadline: null };
  if (project.stage === '已递交') return { archived: false, reason: 'result', label: '等待采购结果', deadline: null };
  const submission = deadlinesOf(project, 'submission').at(-1);
  if (submission && deadlinePassed(submission, time)) return { archived: true, reason: 'submission', label: '响应已截止', at: submission.at, deadline: submission };
  const receipt = deadlinesOf(project, 'receipt').find(d => deadlinePassed(d, time));
  if (receipt && project.receipt_status === '已申请') return { archived: false, reason: 'pending', label: '申请结果待确认', at: receipt.at, deadline: receipt };
  if (project.receipt_status === '已截止' || receipt && project.receipt_status !== '已领取') return { archived: true, reason: 'receipt', label: '领件已截止', at: receipt?.at || project.updated_at || '', deadline: receipt };
  return { archived: false, reason: '', label: '', deadline: null };
}
function discarded(project) { return project.decision === '放弃'; }
function inactive(project) { return projectStatus(project).archived || discarded(project); }
function caStatus(ca) { return ca?.expires_at && parseTime(ca.expires_at) < parseTime(dayKey()) ? '已过期' : ca?.status || '待确认'; }
function caBlocked(project) { return (project.ca_ids || []).some(id => caStatus(caById(id)) !== '有效'); }
function pendingDeadlines(project) {
  if (projectStatus(project).archived || project.stage === '已递交') return [];
  return validDeadlines(project).filter(d => !(deadlineKind(d) === 'receipt' && project.receipt_status === '已领取'));
}
function nextDeadline(project) {
  const status = projectStatus(project);
  if (status.archived || status.reason === 'pending') return status.deadline;
  if (project.stage === '已递交') return null;
  if (project.receipt_status !== '已领取') {
    const receipt = deadlinesOf(project, 'receipt').find(d => !deadlinePassed(d));
    if (receipt) return receipt;
  }
  return pendingDeadlines(project).filter(d => !deadlinePassed(d)).sort((a, b) => deadlineTime(a) - deadlineTime(b))[0] || null;
}
function soon(project) { return !inactive(project) && pendingDeadlines(project).some(d => !deadlinePassed(d) && deadlineTime(d) - Date.now() <= 7 * 86400000); }
function pendingReceipt(project) { return ['未领取', '已申请'].includes(project.receipt_status) && !inactive(project); }
function deadlineState(deadline) {
  if (!deadline) return '';
  const delta = deadlineTime(deadline) - Date.now();
  return delta <= 0 ? 'overdue' : delta < 3 * 86400000 ? 'urgent' : '';
}
function relativeDeadline(deadline) {
  if (!Number.isFinite(deadlineTime(deadline))) return '等待核实';
  if (deadlinePassed(deadline)) return '已截止';
  const days = Math.round((parseTime(dayKey(deadline.at)) - parseTime(dayKey())) / 86400000);
  if (days === 0) return dateOnly(deadline) ? '今日截止，时刻待确认' : '今天截止';
  if (days === 1) return '明天截止';
  return days <= 7 ? '还有 ' + days + ' 天' : '';
}
function listFilters() { return state.view === 'expired' ? state.expired : state.view === 'discarded' ? state.discarded : state; }
function inProjectView(project, view = state.view) {
  if (view === 'discarded') return discarded(project);
  return !discarded(project) && projectStatus(project).archived === (view === 'expired');
}
function updateNavigation() {
  const counter = document.querySelector('#expired-count');
  if (counter) counter.textContent = state.data.projects.filter(p => inProjectView(p, 'expired')).length;
  const discardedCounter = document.querySelector('#discarded-count');
  if (discardedCounter) discardedCounter.textContent = state.data.projects.filter(discarded).length;
  document.querySelectorAll('[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === state.view);
    el.setAttribute('aria-current', el.dataset.view === state.view ? 'page' : 'false');
  });
  const breadcrumb = document.querySelector('.breadcrumb strong');
  if (breadcrumb) breadcrumb.textContent = viewNames[state.view] || '招标管理';
  const active = state.data.projects.filter(p => !inactive(p));
  const metrics = { active: active.length, soon: active.filter(soon).length, receipt: active.filter(pendingReceipt).length, ca: active.filter(caBlocked).length };
  document.querySelectorAll('[data-metric]').forEach(node => {
    node.querySelector('.metric-number').innerHTML = `${metrics[node.dataset.metric]}<small>项</small>`;
  });
}

async function api(path, options = {}) {
  const headers = { 'X-Requested-With': 'XMLHttpRequest', ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${API}${path}`, { ...options, headers, credentials: 'same-origin' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || data.detail || data.message || `请求失败（${response.status}）`);
    error.status = response.status;
    if (response.status === 401 && path !== '/login') renderLogin();
    if (response.status === 409) error.message = '这条记录已被更新，请点击刷新后重新编辑。';
    throw error;
  }
  return data;
}

function toast(message, error = false) {
  const node = document.querySelector('#toast');
  clearTimeout(toastTimer);
  node.textContent = message;
  node.className = `visible${error ? ' error' : ''}`;
  toastTimer = setTimeout(() => { node.className = ''; }, error ? 6500 : 3500);
}

async function load(quiet = false) {
  try {
    const data = await api('/bootstrap');
    state.data = { ...data, projects: data.projects || [], cas: data.cas || [], activity: data.activity || [] };
    document.body.classList.remove('signed-out');
    const name = typeof data.user === 'string' ? data.user : data.user?.name || data.user?.actor || '管理员';
    document.querySelector('#current-user').textContent = name;
    document.querySelector('.user-avatar').textContent = name.slice(0, 1);
    const previousScroll = window.scrollY;
    render();
    window.scrollTo(0, previousScroll);
    if (state.pendingDrawer && projectById(state.pendingDrawer.id)) {
      state.selected = state.pendingDrawer.id;
      state.detailTab = state.pendingDrawer.tab;
      state.pendingDrawer = null;
      document.body.style.overflow = 'hidden';
    }
    if (state.selected && projectById(state.selected)) renderDrawer();
    renderUploadStatus();
    if (quiet) toast('台账已更新');
    if (state.pendingEditor) {
      const draft = state.pendingEditor;
      state.pendingEditor = null;
      state.editing = draft.editing;
      showEditor(draft.html);
      [...editor.querySelectorAll('input,select,textarea')].forEach((node, index) => { node.value = draft.values[index].value; node.checked = draft.values[index].checked; });
      const submit = editor.querySelector('[type=submit]');
      submit.disabled = false;
      submit.textContent = draft.editing.kind === 'project' ? '保存项目' : '保存证书';
      editorInitial = draft.initial;
      toast('已恢复未保存的修改');
    }
  } catch (error) {
    if (error.status !== 401) {
      if (quiet || state.data.user) toast('刷新失败，当前内容已保留。' + error.message, true);
      else main.innerHTML = `<div class="empty-state"><span class="empty-icon">↻</span><h3>暂时无法读取台账</h3><p>${esc(error.message)}</p><button class="btn btn-primary" data-action="refresh">重新连接</button></div>`;
    }
  }
}

function renderLogin(errorMessage = '', username = '') {
  if (projectActionDialog.open) projectActionDialog.close();
  if (state.selected) state.pendingDrawer = { id: state.selected, tab: state.detailTab };
  closeDrawer();
  if (editor.open) {
    state.pendingEditor = { html: editor.innerHTML, editing: state.editing, initial: editorInitial,
      values: [...editor.querySelectorAll('input,select,textarea')].map(node => ({ value: node.value, checked: node.checked })) };
    editor.close();
  }
  document.body.classList.add('signed-out');
  main.innerHTML = `<div class="login-layout">
    <section class="login-visual" aria-label="实时连接">
      <img class="login-art" src="/mgmt/bids/assets/login-connection.webp" alt="" fetchpriority="high">

    </section>
    <div class="login-panel">
      <a class="login-brand" href="https://www.yiyouyinli.com" target="_blank" rel="noopener"><img src="/mgmt/bids/assets/brand-mark.svg" alt="" width="44" height="44"><span>亿有引力<small>企业管理</small></span></a>
      <form id="login-form" class="login-card">
        <h1>登录招标管理</h1>
        ${errorMessage ? `<div class="form-error" role="alert">${esc(errorMessage)}</div>` : ''}
        <label class="field">用户名<input name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${esc(username)}" placeholder="输入用户名"></label>
        <label class="field">密码<span class="password-wrap"><input id="login-password" name="password" type="password" autocomplete="current-password" required placeholder="输入密码"><button class="password-toggle" type="button" data-action="toggle-password" aria-label="显示密码" aria-pressed="false">显示</button></span></label>
        <button class="btn btn-primary" type="submit">登录后台</button>
      </form>
      <div class="login-footer">北京亿有引力科技有限责任公司</div>
    </div>
  </div>`;
  setTimeout(() => main.querySelector(`[name="${username ? 'password' : 'username'}"]`)?.focus(), 20);
}

function heading(title, subtitle, extra = '') {
  return `<div class="page-heading"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div><div class="actions"><button class="btn btn-quiet" data-action="refresh">↻ 刷新</button>${extra}</div></div>`;
}

function render() {
  updateNavigation();
  const views = { projects: renderProjects, expired: renderProjects, discarded: renderProjects, calendar: renderCalendar, cas: renderCAs, discover: renderDiscover, activity: renderActivity };
  (views[state.view] || renderProjects)();
  saveViewState();
}

function filteredProjects() {
  const filters = listFilters();
  const archived = state.view === 'expired';
  const discardedView = state.view === 'discarded';
  const term = filters.query.trim().toLowerCase();
  return state.data.projects.filter(p => {
    const status = projectStatus(p);
    if (!inProjectView(p)) return false;
    if (term && ![p.title, p.project_code, p.buyer, p.platform, p.region, p.summary, p.owner].join(' ').toLowerCase().includes(term)) return false;
    if (filters.platform && p.platform !== filters.platform) return false;
    if (filters.stage && p.stage !== filters.stage) return false;
    if (filters.decision && p.decision !== filters.decision) return false;
    if (archived) return !filters.reason || status.reason === filters.reason;
    if (discardedView) return true;
    if (filters.quick === 'active' && inactive(p)) return false;
    if (filters.quick === 'soon' && !soon(p)) return false;
    if (filters.quick === 'receipt' && !pendingReceipt(p)) return false;
    if (filters.quick === 'ca' && (!caBlocked(p) || inactive(p))) return false;
    return true;
  }).sort((a, b) => {
    if ((a.pinned === true) !== (b.pinned === true)) return a.pinned === true ? -1 : 1;
    if (discardedView) return (parseTime(b.updated_at) || 0) - (parseTime(a.updated_at) || 0);
    if (archived) return (parseTime(projectStatus(b).at) || 0) - (parseTime(projectStatus(a).at) || 0);
    const pendingA = projectStatus(a).reason === 'pending';
    const pendingB = projectStatus(b).reason === 'pending';
    if (pendingA !== pendingB) return pendingA ? -1 : 1;
    return (deadlineTime(nextDeadline(a)) || Infinity) - (deadlineTime(nextDeadline(b)) || Infinity);
  });
}

function options(values, selected, placeholder = '') {
  const available = selected && !values.includes(selected) ? [...values, selected] : values;
  return (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') + available.map(v => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v === '放弃' ? '弃标' : v)}</option>`).join('');
}

function renderProjects() {
  const archived = state.view === 'expired';
  const discardedView = state.view === 'discarded';
  const historyView = archived || discardedView;
  const filters = listFilters();
  const values = state.data.projects.filter(p => inProjectView(p));
  const active = state.data.projects.filter(p => !inactive(p));
  const metrics = [
    ['active', '进行中项目', active.length], ['soon', '未来 7 天截止', active.filter(soon).length],
    ['receipt', '待领取采购文件', active.filter(pendingReceipt).length], ['ca', 'CA 待落实', active.filter(caBlocked).length]
  ];
  const platforms = [...new Set(values.map(p => p.platform).filter(Boolean))].sort();
  main.innerHTML = heading(discardedView ? '已弃标' : archived ? '已过期' : '项目台账', discardedView ? '保留采购资料，需要时恢复跟进' : archived ? '查看已截止与已结束的采购项目' : '跟进采购机会、领件进展与投标安排',
    '<a class="btn" href="/mgmt/bids/api/export">导出台账</a>' + (!historyView ? '<button class="btn btn-primary" data-action="new-project">＋ 新增项目</button>' : ''))
    + (historyView ? `<div class="archive-summary"><span>共 <strong>${values.length}</strong> 个${discardedView ? '已弃标' : '历史'}项目</span><span>${discardedView ? '恢复后按原阶段和截止时间归入台账' : '置顶优先，其余按截止或更新时间排列'}</span></div>`
      : `<div class="metric-grid">${metrics.map(([key, label, count]) => `<button class="metric" data-metric="${key}"><span class="metric-label">${label}</span><span class="metric-dot"></span><span class="metric-number">${count}<small>项</small></span><span class="metric-note">查看项目 →</span></button>`).join('')}</div>`)
    + `<section class="card"><div class="card-heading"><h2>${discardedView ? '已弃标项目' : archived ? '历史项目' : '当前项目'}<span class="count">共 ${values.length} 项</span></h2><span class="muted">北京时间</span></div>
    ${discardedView ? '' : archived ? `<div class="quick-filters expired-filters">${[['','全部'],['receipt','领件已截止'],['submission','响应已截止'],['ended','已结束']].map(([key,label]) => `<button class="quick-filter${filters.reason === key ? ' active' : ''}" data-expired-reason="${key}">${label}</button>`).join('')}</div>`
      : `<div class="quick-filters">${[['all','当前项目'],['active','进行中'],['soon','近期截止'],['receipt','待领件'],['ca','CA 待落实']].map(([key,label]) => `<button class="quick-filter${filters.quick === key ? ' active' : ''}" data-quick="${key}">${label}</button>`).join('')}<button class="quick-filter" data-action="show-expired">查看已过期 →</button></div>`}
    <div class="filters"><label class="search-box"><span aria-hidden="true">⌕</span><span class="visually-hidden">搜索项目</span><input id="project-search" value="${esc(filters.query)}" placeholder="搜索项目、采购人或编号"></label><select id="platform-filter" aria-label="按采购平台筛选">${options(platforms,filters.platform,'全部平台')}</select><select id="stage-filter" aria-label="按阶段筛选">${options(stages,filters.stage,'全部阶段')}</select>${discardedView ? '' : `<select id="decision-filter" aria-label="按参与决策筛选">${options(decisions.filter(d => d !== '放弃'),filters.decision,'全部决策')}</select>`}</div><div id="filter-summary"></div><div id="project-results"></div></section>`;
  renderProjectResults();
}
function renderProjectResults(resetScroll = false) {
  const target = document.querySelector('#project-results');
  if (!target) return;
  const previousTable = target.querySelector('.table-wrap');
  const savedTable = state.scroll[state.view + '-table'] || {};
  const tablePosition = resetScroll ? { top: 0, left: 0 } : {
    top: previousTable?.scrollTop ?? savedTable.top ?? 0,
    left: previousTable?.scrollLeft ?? savedTable.left ?? 0
  };
  const archived = state.view === 'expired';
  const discardedView = state.view === 'discarded';
  const filters = listFilters();
  const rows = filteredProjects();
  const pageSize = 12;
  const pages = Math.max(1,Math.ceil(rows.length / pageSize));
  filters.page = Math.min(Math.max(1,filters.page),pages);
  const shown = rows.slice((filters.page - 1) * pageSize,filters.page * pageSize);
  const chips = [['query','搜索',filters.query],['platform','平台',filters.platform],['stage','阶段',filters.stage],['decision','决策',filters.decision]].filter(x => x[2]);
  document.querySelector('#filter-summary').innerHTML = chips.length ? `<div class="active-filters">${chips.map(([key,label,value]) => `<button class="filter-chip" data-clear-filter="${key}">${label} · ${esc(value)} <span aria-hidden="true">×</span></button>`).join('')}<button class="text-button" data-action="reset-filters">清除筛选</button></div>` : '';
  target.innerHTML = shown.length ? `<div class="table-wrap"><table class="project-table"><thead><tr><th>项目 / 采购单位</th><th>预算金额</th><th>跟进状态</th><th>${archived ? '截止原因' : '下一关键节点'}</th><th>领件情况</th><th>CA / 资料</th><th>操作</th></tr></thead><tbody>${shown.map(p => {
    const status = projectStatus(p);
    const d = nextDeadline(p);
    const response = deadlinesOf(p, 'submission').at(-1);
    const cas = (p.ca_ids || []).map(id => caById(id));
    const caLabel = cas.length ? (caBlocked(p) ? `${cas.filter(c => caStatus(c) !== '有效').length} 项待落实` : '证书有效') : '要求待确认';
    const deadline = discardedView ? `<span class="archive-reason">已停止跟进</span><span class="cell-secondary">${response ? '响应 · ' + esc(formatDeadline(response)) : '恢复后按原节点继续跟进'}</span>` : archived ? `<span class="archive-reason">${esc(status.label)}</span><span class="cell-secondary">${status.deadline ? esc(formatDeadline(status.deadline)) : '记录更新 ' + esc(formatTime(status.at))}</span>`
      : status.reason === 'result' ? '<span class="node-label">等待采购结果</span>'
      : status.reason === 'pending' ? `<span class="deadline-text urgent">申请结果待确认</span><span class="cell-secondary">领件截止已过，请联系采购方核实</span>${response ? `<span class="cell-secondary">响应 · ${esc(formatDeadline(response))}</span>` : ''}`
      : `<span class="node-label">${esc(d?.label || '截止时间待确认')}</span><span class="deadline-text ${deadlineState(d)}">${d ? esc(formatDeadline(d)) : '待核实'}</span>${d ? `<span class="cell-secondary relative-time">${esc(relativeDeadline(d))}</span>` : ''}`;
    const materials = p.materials || [];
    return `<tr${p.pinned === true ? ' class="project-pinned"' : ''}><td data-cell="project">${pinBadge(p)}<button class="project-title" data-open="${esc(p.id)}">${esc(p.title)}</button><div class="project-meta">${esc(p.buyer || p.platform || '采购单位待补充')}</div>${p.project_code ? `<div class="cell-secondary project-code">${esc(p.project_code)}</div>` : ''}</td><td data-label="预算金额" class="nowrap">${money(p.budget)}${budgetTaxLabel(p) ? `<span class="cell-secondary">${esc(budgetTaxLabel(p))}</span>` : ''}</td><td data-label="跟进状态"><div class="project-state">${badge(p.stage)}${badge(p.decision)}</div><span class="cell-secondary">${esc(p.owner || '负责人待分配')}</span></td><td data-label="${archived ? '截止原因' : '下一关键节点'}">${deadline}</td><td data-label="领件情况">${badge(p.receipt_status)}</td><td data-label="CA / 资料"><span class="ca-text ${caBlocked(p) ? 'danger' : cas.length ? '' : 'warn'}">${esc(caLabel)}</span><span class="cell-secondary">${materials.length ? `材料 ${materials.filter(m => m.done).length}/${materials.length}` : '材料待登记'} · 附件 ${(p.attachments || []).length}</span></td><td data-label="操作"><div class="project-row-actions"><button class="text-button" data-open="${esc(p.id)}" aria-label="查看${esc(p.title)}">查看 →</button>${projectActionButtons(p)}</div></td></tr>`;
  }).join('')}</tbody></table></div><div class="table-footer"><span>显示 ${(filters.page - 1) * pageSize + 1}–${Math.min(filters.page * pageSize,rows.length)} 项，共 ${rows.length} 项</span><div class="pagination"><button data-page="${filters.page - 1}" ${filters.page === 1 ? 'disabled' : ''} aria-label="上一页">‹</button><span>${filters.page} / ${pages}</span><button data-page="${filters.page + 1}" ${filters.page === pages ? 'disabled' : ''} aria-label="下一页">›</button></div></div>`
    : '<div class="empty-state"><h3>没有符合条件的项目</h3><p>调整搜索或筛选条件后继续查看。</p><button class="btn" data-action="reset-filters">清除筛选</button></div>';
  const table = target.querySelector('.table-wrap');
  if (table) { table.scrollTop = tablePosition.top; table.scrollLeft = tablePosition.left; }
  state.scroll[state.view + '-table'] = tablePosition;
  saveViewState();
}

function renderCAs() {
  main.innerHTML = heading('CA 证书', '登记办理状态、有效期与适用采购平台', '<button class="btn btn-primary" data-action="new-ca">＋ 登记证书</button>')
    + `<div class="ca-grid">${state.data.cas.map(c => {
      const linked = state.data.projects.filter(p => (p.ca_ids || []).map(String).includes(String(c.id)) && !inactive(p)).length;
      return `<section class="card ca-card"><div class="ca-card-head"><div><h2>${esc(c.name)}</h2><div class="ca-platform">${esc(c.platform || '适用平台待确认')}</div></div>${badge(caStatus(c), 'ca')}</div><dl class="ca-details"><dt>证书机构</dt><dd>${esc(c.issuer || '待补充')}</dd><dt>有效期至</dt><dd>${c.expires_at ? esc(formatTime(c.expires_at, true)) : '待补充'}</dd><dt>保管人</dt><dd>${esc(c.holder || '待分配')}</dd><dt>办理备注</dt><dd>${esc(c.notes || '暂无备注')}</dd></dl><div class="ca-card-footer"><span>${linked} 个进行中项目关联</span><button class="btn btn-small" data-edit-ca="${esc(c.id)}">编辑信息</button></div></section>`;
    }).join('')}</div>` + (!state.data.cas.length ? '<section class="card empty-state"><h3>还没有登记 CA 证书</h3><p>登记证书后，可在项目中关联所需 CA，查看是否具备递交条件。</p></section>' : '');
}

function allEvents() {
  return state.data.projects.filter(p => !discarded(p)).flatMap(project => validDeadlines(project).map(deadline => ({ project, deadline }))).sort((a, b) => parseTime(a.deadline.at) - parseTime(b.deadline.at));
}

function candidateImported(candidate) {
  const source = candidate.source_url || candidate.url || candidate.link || '';
  return state.data.projects.some(p => (source && p.source_url === source) || p.title === (candidate.title || candidate.name));
}

function renderCalendar() {
  const first = new Date(Date.UTC(state.year, state.month, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(state.year, state.month + 1, 0)).getUTCDate();
  const slots = Math.ceil((offset + days) / 7) * 7;
  const events = state.calendarHistory ? state.data.projects.filter(p => !discarded(p)).flatMap(project => (project.deadlines || []).filter(d => Number.isFinite(parseTime(d.at))).map(deadline => ({ project, deadline }))) : allEvents();
  const activeEvents = state.calendarHistory ? events : events.filter(x => !inactive(x.project) && pendingDeadlines(x.project).includes(x.deadline) && !deadlinePassed(x.deadline));
  const cells = Array.from({ length: slots }, (_, i) => {
    const d = new Date(Date.UTC(state.year, state.month, i - offset + 1));
    const key = d.toISOString().slice(0, 10);
    const dayEvents = activeEvents.filter(x => dayKey(x.deadline.at) === key);
    const off = d.getUTCMonth() !== state.month;
    return `<div class="calendar-day${off ? ' off' : ''}${key === dayKey() ? ' today' : ''}"><span class="calendar-date">${d.getUTCDate()}</span>${dayEvents.map(x => `<button class="calendar-event${deadlinePassed(x.deadline) || x.deadline.is_current === false ? ' past' : ''}" title="${esc(x.project.title + ' · ' + x.deadline.label + ' · ' + formatDeadline(x.deadline))}" data-open="${esc(x.project.id)}">${esc(x.project.title)}<small>${esc(x.deadline.label)} · ${esc(formatDeadline(x.deadline).split(' ').at(-1))}</small></button>`).join('')}</div>`;
  }).join('');
  const future = allEvents().filter(x => !inactive(x.project) && !deadlinePassed(x.deadline) && pendingDeadlines(x.project).includes(x.deadline)).slice(0, 12);
  main.innerHTML = heading('截止日历', '各阶段节点按北京时间显示，点击项目查看完整安排')
    + `<section class="card"><div class="card-heading"><div class="month-heading"><button class="icon-btn" data-month="-1" aria-label="上个月">‹</button><h2>${state.year} 年 ${state.month + 1} 月</h2><button class="icon-btn" data-month="1" aria-label="下个月">›</button></div><div class="actions"><button class="btn btn-small" data-action="calendar-history" aria-pressed="${state.calendarHistory}">${state.calendarHistory ? '隐藏历史节点' : '显示历史节点'}</button><button class="btn btn-small" data-action="calendar-today">本月</button></div></div><div class="calendar-scroll"><div class="calendar-week">${['一', '二', '三', '四', '五', '六', '日'].map(x => `<span>周${x}</span>`).join('')}</div><div class="calendar-grid">${cells}</div></div></section><h2 class="section-subtitle">接下来要完成的节点</h2><section class="card"><div class="deadline-list">${future.map(x => `<div class="deadline-list-row"><div class="deadline-date-block">${esc(formatDeadline(x.deadline).split(' ')[0])}<small>${esc(formatDeadline(x.deadline).split(' ').slice(1).join(' '))}</small></div><div class="deadline-row-main"><button class="project-title" data-open="${esc(x.project.id)}">${esc(x.project.title)}</button><small>${esc(x.deadline.label)}${x.deadline.note ? ' · ' + esc(x.deadline.note) : ''}</small></div>${badge(x.project.decision)}</div>`).join('') || '<div class="empty-state"><h3>暂无已登记的未来截止节点</h3><p>在项目详情中编辑日期，可开启历史节点查看已截止安排。</p></div>'}</div></section>`;
}

function renderDiscover() {
  const found = state.discovery;
  const candidates = found?.candidates || found?.results || [];
  const links = found?.manualSearch || found?.manual_search || found?.search_links || found?.links || [];
  const errors = found?.errors || [];
  main.innerHTML = heading('发现新项目', '搜索公开采购公告，核实资格和时间后加入台账')
    + `<section class="card discover-card"><form id="discover-form" class="discover-form"><label class="visually-hidden" for="discover-query">采购关键词</label><input id="discover-query" name="query" value="${esc(state.discoverQuery)}" placeholder="输入项目关键词，如软件开发、音视频、RTC" required maxlength="200"><button class="btn btn-primary" type="submit"${state.discovering ? ' disabled' : ''}>${state.discovering ? '正在检索…' : '⌕ 搜索最新公告'}</button></form><div class="discover-description">搜索结果保留原始来源。预算、资格、CA 与截止时间以采购人的正式公告和采购文件为准，加入后继续核对。</div><div class="search-chips">${['音视频 RTC', '软件开发', '智能客服 机器人', '门户 平台开发', '人工智能'].map(x => `<button class="search-chip" data-search-term="${esc(x)}">${esc(x)}</button>`).join('')}</div></section>`
    + (state.discovering ? '<div class="loading-state"><span class="spinner"></span><p>正在检索公开公告来源…</p></div>' : '')
    + (found && !state.discovering ? `<h2 class="section-subtitle">检索结果<span class="count">${candidates.length} 条${(found.searched_at || found.checked_at) ? ' · ' + esc(formatTime(found.searched_at || found.checked_at, true)) : ''}</span></h2>${errors.length ? `<div class="banner">${errors.map(x => esc(typeof x === 'string' ? x : [x.source, x.message || x.error || '检索失败'].filter(Boolean).join(' · '))).join('<br>')}</div>` : ''}${links.length ? `<div class="manual-links">${links.map(x => externalLink(typeof x === 'string' ? x : x.url, typeof x === 'string' ? '打开采购平台' : x.name || x.title || x.label || '查看来源')).join('')}</div>` : ''}<section class="card">${candidates.map((p, i) => `<article class="discover-item"><div class="discover-item-content"><h3>${esc(p.title || p.name || '采购公告')}</h3><div class="discover-item-meta"><span>${esc(p.platform || p.source || '')}</span><span>${esc(p.region || '')}</span>${p.published_at ? `<span>${esc(formatTime(p.published_at, true))}</span>` : ''}<span class="badge amber">待核实</span></div><p>${esc(p.summary || p.snippet || p.description || '')}</p>${externalLink(p.source_url || p.url || p.link, '查看原始公告')}</div><button class="btn btn-small" data-import="${i}"${candidateImported(p) ? ' disabled' : ''}>${candidateImported(p) ? '已加入台账' : '＋ 加入台账'}</button></article>`).join('') || '<div class="empty-state"><h3>本次没有返回可添加的公告</h3><p>可以调整关键词重试，或打开采购平台手动核对后新增项目。</p></div>'}</section>` : '');
}

function renderActivity() {
  const values = [...state.data.activity].sort((a, b) => parseTime(b.at || b.created_at) - parseTime(a.at || a.created_at));
  main.innerHTML = heading('操作记录', '记录项目、资料和证书信息的变更')
    + `<section class="card"><div class="card-heading"><h2>最近更新<span class="count">${values.length} 条</span></h2></div><div class="activity-list">${values.map(x => `<div class="activity-item"><span class="activity-point"></span><div class="activity-content">${esc(x.action || x.title || '更新记录')}<small>${esc([x.actor || x.user || '', x.detail || x.description || x.project_title || (x.action ? x.title : '') || ''].filter(Boolean).join(' · '))}</small></div><time class="activity-time">${esc(formatTime(x.at || x.created_at, true))}</time></div>`).join('') || '<div class="empty-state"><h3>暂无操作记录</h3><p>添加或更新信息后，记录会出现在这里。</p></div>'}</div></section>`;
}

function openProject(id) {
  if (!state.selected) drawerTrigger = document.activeElement;
  state.scroll[state.view] = window.scrollY;
  saveViewState();
  state.selected = id;
  state.detailTab = 'overview';
  renderDrawer();
  document.body.style.overflow = 'hidden';
  setTimeout(() => drawerRoot.querySelector('[data-action="close-drawer"]')?.focus(), 20);
}

function closeDrawer() {
  const previousId = state.selected;
  state.selected = null;
  drawerRoot.innerHTML = '';
  document.body.style.overflow = '';
  if (drawerTrigger?.isConnected) drawerTrigger.focus({ preventScroll: true });
  else if (previousId) (main.querySelector(`[data-open="${CSS.escape(String(previousId))}"]`) || main).focus({ preventScroll: true });
  drawerTrigger = null;
}

function contactActions(project) {
  const evidence = [project.notes, project.requirements].join(' ');
  const contacts = [...new Set(evidence.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b|\b1[3-9]\d{9}\b|\b0\d{2,3}-\d{7,8}\b/g) || [])].slice(0, 8);
  return contacts.length ? `<section class="detail-section"><h3>联系信息</h3><div class="contact-actions">${contacts.map(value => `<button class="btn btn-small" data-copy="${esc(value)}" aria-label="复制${esc(value)}">${esc(value)} <span aria-hidden="true">⧉</span></button>`).join('')}</div></section>` : '';
}
function copyText(value, placeholder = '待补充') { return value ? `<div class="detail-copy">${esc(value)}</div>` : `<div class="detail-copy empty">${esc(placeholder)}</div>`; }

function renderDrawer() {
  const p = projectById(state.selected);
  if (!p) return closeDrawer();
  const status = projectStatus(p);
  const next = nextDeadline(p);
  const note = status.label || (next ? (next.label || '下一关键节点') + ' · ' + formatDeadline(next) : '截止时间待确认');
  let body = '';
  if (state.detailTab === 'overview') {
    body = `<dl class="detail-grid">${[
      ['采购单位', p.buyer], ['项目编号', p.project_code], ['采购平台', p.platform], ['地区', p.region],
      ['预算 / 最高限价', `${money(p.budget)}${budgetTaxLabel(p) ? ' · ' + budgetTaxLabel(p) : ''}`], ['负责人', p.owner],
      ['参与决策', p.decision], ['文件领取', p.receipt_status], ['当前安排', note]
    ].map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value || '待补充')}</dd></div>`).join('')}</dl><section class="detail-section"><h3>项目需求</h3>${copyText(p.summary)}</section><section class="detail-section"><h3>资格与交付要求</h3>${copyText(p.requirements)}</section><section class="detail-section"><h3>所需 CA 证书</h3>${(p.ca_ids || []).length ? p.ca_ids.map(id => { const c = caById(id); return `<div class="detail-ca-row"><span>${esc(c?.name || '证书待确认')}<small class="cell-secondary">${esc(c?.platform || '')}</small></span>${badge(caStatus(c))}</div>`; }).join('') : '<div class="detail-copy empty">暂未登记 CA 要求</div>'}</section><section class="detail-section"><h3>跟进备注</h3>${copyText(p.notes)}</section>${contactActions(p)}<section class="detail-section"><h3>公告来源</h3><div class="source-link">${externalLink(p.source_url, '打开采购公告')}${p.source_url ? ` <button class="text-button" data-copy="${esc(p.source_url)}">复制链接</button>` : ''}</div><p class="form-note">${p.verified_at ? '资料核对时间 ' + esc(formatTime(p.verified_at, true)) : '来源与信息仍待核对'}</p></section>`;
  } else if (state.detailTab === 'planning') {
    const ds = [...(p.deadlines || [])].sort((a, b) => (parseTime(a.at) || Infinity) - (parseTime(b.at) || Infinity));
    body = `<section class="detail-section"><h3>阶段截止时间</h3>${ds.length ? ds.map(d => `<div class="deadline-item${d.is_current === false ? ' historical' : ''}"><h4>${esc(d.label || d.type || '截止节点')}</h4><span class="deadline-text ${deadlineState(d)}">${esc(formatDeadline(d, true))}</span>${deadlineKind(d) === 'receipt' && p.receipt_status === '已领取' ? ' <span class="badge teal">已领取</span>' : d.is_current === false ? ' <span class="badge gray">历史节点</span>' : !Number.isFinite(parseTime(d.at)) ? ' <span class="badge amber">时间待确认</span>' : deadlinePassed(d) ? ' <span class="badge gray">已截止</span>' : pendingDeadlines(p).includes(d) ? ' <span class="badge blue">待办理</span>' : ' <span class="badge gray">已结束</span>'}<p>${esc(d.note || '')}</p>${d.source ? `<div class="source-link">${url(d.source) ? externalLink(d.source, '节点依据') : esc(d.source)}</div>` : ''}</div>`).join('') : '<div class="detail-copy empty">尚未登记截止时间</div>'}</section><section class="detail-section"><h3>材料准备<span class="count">${(p.materials || []).filter(m => m.done).length} / ${(p.materials || []).length} 已完成</span></h3><div class="checklist">${(p.materials || []).map((m, i) => `<label><input type="checkbox" data-material="${i}"${m.done ? ' checked' : ''}><span class="${m.done ? 'done' : ''}">${esc(m.label)}</span></label>`).join('') || '<div class="detail-copy empty">在编辑项目中添加所需材料</div>'}</div></section>`;
  } else {
    body = `<div class="upload-zone" tabindex="0" aria-label="拖放一个项目文件到此处"><div>采购文件与项目资料<small>拖放一个文件，或点击上传 · 最大32 MB</small></div><label class="btn btn-small">＋ 上传文件<input id="attachment-upload" type="file" class="visually-hidden" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.html,.zip,.zcx,.zgdxnzf,.jpg,.jpeg,.png"></label></div><div id="upload-status" class="upload-status" aria-live="polite"></div>${(p.attachments || []).map(a => `<div class="attachment-row"><span class="attachment-icon">${esc(a.name?.split('.').at(-1)?.toUpperCase().slice(0,5) || 'FILE')}</span><div class="attachment-main"><a class="attachment-name" href="${API}/attachments/${encodeURIComponent(a.id)}" target="_blank" rel="noopener">${esc(a.name)}</a><small>${sizeLabel(a.size)} · ${esc(formatTime(a.uploaded_at, true))}</small></div><a class="btn btn-small" href="${API}/attachments/${encodeURIComponent(a.id)}" download>下载</a></div>`).join('') || '<div class="empty-state"><span class="empty-icon">▤</span><h3>还没有项目文件</h3><p>上传采购文件后，可在这里查看和下载。原始公告请从项目概览打开。</p></div>'}`;
  }
  const previousTab = drawerRoot.querySelector('.tab[aria-selected=true]')?.dataset.tab;
  const previousScroll = drawerRoot.querySelector('.drawer-body')?.scrollTop || 0;
  drawerRoot.innerHTML = `<div class="drawer-backdrop" data-action="close-drawer"></div><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="project-detail-title"><div class="drawer-heading"><div class="drawer-topline"><span>${esc(p.platform || '项目详情')}</span><button class="icon-btn" data-action="close-drawer" aria-label="关闭项目详情">×</button></div>${pinBadge(p)}<h2 id="project-detail-title">${esc(p.title)}</h2><div class="drawer-meta">${badge(p.stage)}${badge(p.decision)}<span class="drawer-actions"><button class="btn btn-small" data-edit-project="${esc(p.id)}">编辑项目</button></span></div><div class="drawer-project-actions">${projectActionButtons(p)}</div></div><div class="tabs" role="tablist">${[['overview', '项目概览'], ['planning', '节点与材料'], ['files', '采购文件']].map(([key, title]) => `<button role="tab" aria-selected="${state.detailTab === key}" class="tab${state.detailTab === key ? ' active' : ''}" data-tab="${key}">${title}</button>`).join('')}</div><div class="drawer-body">${body}</div><div class="drawer-footer"><span>最后更新 ${esc(formatTime(p.updated_at, true))}</span><span>记录版本 ${esc(p.version || 1)}</span></div></aside>`;
  if (previousTab === state.detailTab) drawerRoot.querySelector('.drawer-body').scrollTop = previousScroll;
  if (state.detailTab === 'files') renderUploadStatus();
}

function field(label, name, value = '', type = 'text', extra = '') {
  return `<label class="field ${extra}">${esc(label)}<input type="${type}" name="${name}" value="${esc(value)}"${name === 'title' || name === 'name' ? ' required' : ''}></label>`;
}

function selectField(label, name, values, selected) { return `<label class="field">${esc(label)}<select name="${name}">${options(values, selected)}</select></label>`; }
function textField(label, name, value, rows = 3) { return `<label class="field full">${esc(label)}<textarea name="${name}" rows="${rows}">${esc(value)}</textarea></label>`; }

function deadlineEditor(d = {}, index = 0) {
  const onlyDate = dateOnly(d);
  const at = Number.isFinite(parseTime(d.at)) ? onlyDate ? dayKey(d.at) : `${dayKey(d.at)}T${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(parseTime(d.at))}` : '';
  const typeNames = { registration: '报名', receipt: '领件', clarification: '澄清', guarantee: '保证金', submission: '递交', opening: '开标', other: '其他' };
  const types = Object.keys(typeNames);
  if (d.type && !types.includes(d.type)) { types.push(d.type); typeNames[d.type] = d.type; }
  return `<div class="repeat-row deadline-editor"><div class="repeat-header"><span>阶段节点 ${index + 1}</span><button type="button" class="text-button btn-danger" data-remove-row>移除</button></div><div class="form-grid">${field('节点名称', 'deadline-label', d.label || '')}<label class="field">节点类型<select name="deadline-type">${types.map(t => `<option value="${esc(t)}"${t === (d.type || 'other') ? ' selected' : ''}>${esc(typeNames[t])}</option>`).join('')}</select></label><label class="field">截止时间 · 北京时间<input name="deadline-at" type="${onlyDate ? 'date' : 'datetime-local'}" value="${at}"></label>${field('节点依据 · 链接或文件名', 'deadline-source', d.source || '')}<label class="inline-check"><input type="checkbox" name="deadline-date-only"${onlyDate ? ' checked' : ''}>仅知道截止日期</label><label class="inline-check"><input type="checkbox" name="deadline-current"${d.is_current !== false ? ' checked' : ''}>当前有效节点</label><label class="field full">节点说明<input name="deadline-note" value="${esc(d.note || '')}" placeholder="延期后可取消旧节点的当前有效状态"></label></div></div>`;
}

function materialEditor(m = {}) {
  return `<div class="material-editor-row"><input type="checkbox" name="material-done" aria-label="材料已完成"${m.done ? ' checked' : ''}><input type="text" name="material-label" value="${esc(m.label || '')}" placeholder="材料名称，如营业执照、社保缴纳证明" aria-label="材料名称"><button type="button" class="icon-btn" data-remove-row aria-label="移除此项材料">×</button></div>`;
}

function editorSnapshot() {
  return JSON.stringify([...editor.querySelectorAll('input,select,textarea')].map(node => [node.name, node.type, node.value, node.checked]));
}
function requestCloseEditor() {
  if (state.saving) return false;
  if (editor.open && editorInitial !== editorSnapshot() && !window.confirm('还有未保存的修改，确定放弃修改吗？')) return false;
  editor.close();
  state.editing = null;
  editorInitial = '';
  return true;
}
function showEditor(content) {
  editor.className = 'editor-dialog';
  editor.innerHTML = content;
  if (!editor.open) editor.showModal();
  editorInitial = editorSnapshot();
  editor.querySelector('input')?.focus();
}

function editProject(id = null) {
  const p = id ? projectById(id) : {};
  state.editing = { kind: 'project', id, version: p.version };
  showEditor(`<form id="project-form"><div class="editor-header"><h2 id="editor-title">${id ? '编辑项目' : '新增采购项目'}</h2><button type="button" class="icon-btn" data-action="close-editor" aria-label="关闭编辑">×</button></div><div class="editor-body"><div id="form-error" role="alert"></div><div class="form-grid">${field('项目名称 *', 'title', p.title, 'text', 'full')}${field('采购单位', 'buyer', p.buyer)}${field('项目编号', 'project_code', p.project_code)}${field('采购平台', 'platform', p.platform)}${field('地区', 'region', p.region)}${field('预算 / 限价 · 元', 'budget', p.budget ?? '', 'number')}${selectField('金额口径', 'budget_tax', ['待确认', '含税', '不含税', '未披露'], p.budget_tax || '待确认')}${selectField('参与决策', 'decision', decisions, p.decision || '待评估')}${selectField('当前阶段', 'stage', stages, p.stage || '线索')}${selectField('文件领取', 'receipt_status', receipts, p.receipt_status || '未领取')}${field('负责人', 'owner', p.owner)}${field('公告来源链接', 'source_url', p.source_url, 'url', 'full')}${textField('项目需求', 'summary', p.summary || '')}${textField('资格与交付要求', 'requirements', p.requirements || '')}${textField('跟进备注', 'notes', p.notes || '')}</div><h3 class="form-section">阶段截止时间</h3><p class="form-note" style="margin-bottom:14px">填入已经核实的时间，暂不明确的节点可以保留为空。</p><div id="deadline-editors">${(p.deadlines || []).map(deadlineEditor).join('')}</div><button type="button" class="btn btn-small" data-action="add-deadline">＋ 添加阶段节点</button><h3 class="form-section">材料清单</h3><div id="material-editors">${(p.materials || []).map(materialEditor).join('')}</div><button type="button" class="btn btn-small" data-action="add-material">＋ 添加材料</button><h3 class="form-section">所需 CA 证书</h3><div class="ca-checkboxes">${state.data.cas.map(c => `<label><input type="checkbox" name="ca-id" value="${esc(c.id)}"${(p.ca_ids || []).map(String).includes(String(c.id)) ? ' checked' : ''}>${esc(c.name)}${badge(caStatus(c))}</label>`).join('') || '<p class="form-note">先到 CA 证书页登记证书，再关联到项目。</p>'}</div></div><div class="editor-footer"><button class="btn" type="button" data-action="close-editor">取消</button><button class="btn btn-primary" type="submit">保存项目</button></div></form>`);
}

function editCA(id = null) {
  const c = id ? caById(id) : {};
  state.editing = { kind: 'ca', id, version: c.version };
  showEditor(`<form id="ca-form"><div class="editor-header"><h2 id="editor-title">${id ? '编辑 CA 证书' : '登记 CA 证书'}</h2><button type="button" class="icon-btn" data-action="close-editor" aria-label="关闭编辑">×</button></div><div class="editor-body"><div id="form-error" role="alert"></div><div class="form-grid">${field('证书名称 *', 'name', c.name, 'text', 'full')}${field('适用采购平台', 'platform', c.platform)}${field('颁发机构', 'issuer', c.issuer)}${selectField('办理状态', 'status', caStatuses, c.status || '待确认')}${field('有效期至', 'expires_at', c.expires_at ? dayKey(c.expires_at) : '', 'date')}${field('保管人', 'holder', c.holder, 'text', 'full')}${textField('办理进度与备注', 'notes', c.notes || '', 4)}</div></div><div class="editor-footer"><button class="btn" type="button" data-action="close-editor">取消</button><button class="btn btn-primary" type="submit">保存证书</button></div></form>`);
}

async function saveEditor(form, kind) {
  if (state.saving) return;
  const fd = new FormData(form);
  const values = Object.fromEntries(fd);
  let payload;
  if (kind === 'project') {
    payload = {};
    for (const key of ['title', 'buyer', 'project_code', 'platform', 'region', 'budget_tax', 'decision', 'stage', 'receipt_status', 'owner', 'source_url', 'summary', 'requirements', 'notes']) payload[key] = String(values[key] || '').trim();
    payload.budget = values.budget === '' ? null : Number(values.budget);
    if (payload.budget !== null && (!Number.isFinite(payload.budget) || payload.budget < 0)) return showFormError('请输入有效的预算金额。');
    payload.deadlines = [...form.querySelectorAll('.deadline-editor')].map(row => ({
      label: row.querySelector('[name=deadline-label]').value.trim(), type: row.querySelector('[name=deadline-type]').value,
      at: row.querySelector('[name=deadline-at]').value ? row.querySelector('[name=deadline-date-only]').checked ? `${row.querySelector('[name=deadline-at]').value}T00:00:00+08:00` : `${row.querySelector('[name=deadline-at]').value}+08:00` : '',
      date_only: row.querySelector('[name=deadline-date-only]').checked, is_current: row.querySelector('[name=deadline-current]').checked,
      source: row.querySelector('[name=deadline-source]').value.trim(), note: row.querySelector('[name=deadline-note]').value.trim()
    })).filter(x => x.label || x.at);
    payload.materials = [...form.querySelectorAll('.material-editor-row')].map(row => ({ label: row.querySelector('[name=material-label]').value.trim(), done: row.querySelector('[name=material-done]').checked })).filter(x => x.label);
    payload.ca_ids = fd.getAll('ca-id');
  } else {
    payload = {};
    for (const key of ['name', 'platform', 'issuer', 'status', 'holder', 'expires_at', 'notes']) payload[key] = String(values[key] || '').trim();
  }
  if (state.editing.id) payload.version = state.editing.version;
  const group = kind === 'project' ? 'projects' : 'cas';
  const endpoint = state.editing.id ? `/${group}/${encodeURIComponent(state.editing.id)}` : `/${group}`;
  const button = form.querySelector('[type=submit]');
  button.disabled = true;
  const buttonText = button.textContent;
  button.textContent = '正在保存…';
  state.saving = true;
  try {
    const saved = await api(endpoint, { method: state.editing.id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    const collection = kind === 'project' ? 'projects' : 'cas';
    const existing = state.data[collection].findIndex(item => item.id === saved.id);
    if (existing >= 0) state.data[collection][existing] = saved; else state.data[collection].unshift(saved);
    editor.close();
    editorInitial = '';
    state.editing = null;
    await load();
    if (kind === 'project' && !discarded(saved)) openProject(saved.id);
    else if (kind === 'project') closeDrawer();
    toast(kind === 'project' ? '项目已保存' : '证书信息已保存');
  } catch (error) { showFormError(error.message); }
  finally { state.saving = false; button.disabled = false; button.textContent = buttonText; }
}

function showFormError(message) {
  const target = document.querySelector('#form-error');
  if (!target) return toast(message, true);
  target.className = 'form-error';
  target.textContent = message;
  target.scrollIntoView({ block: 'nearest' });
}

async function toggleMaterial(input) {
  if (state.materialSaving) { input.checked = !input.checked; return; }
  const p = projectById(state.selected);
  const materials = structuredClone(p.materials || []);
  materials[Number(input.dataset.material)].done = input.checked;
  state.materialSaving = true;
  drawerRoot.querySelectorAll('[data-material]').forEach(node => { node.disabled = true; });
  try {
    const saved = await api(`/projects/${encodeURIComponent(p.id)}`, { method: 'PATCH', body: JSON.stringify({ version: p.version, materials }) });
    const index = state.data.projects.findIndex(item => item.id === saved.id);
    state.data.projects[index] = saved;
    render();
    if (state.selected) renderDrawer();
  } catch (error) {
    input.checked = !input.checked;
    toast(error.message, true);
  } finally {
    state.materialSaving = false;
    drawerRoot.querySelectorAll('[data-material]').forEach(node => { node.disabled = false; });
  }
}

function renderUploadStatus() {
  const target = drawerRoot.querySelector('#upload-status');
  if (!target) return;
  const upload = state.upload;
  if (!upload || upload.projectId !== state.selected) { target.innerHTML = ''; return; }
  target.innerHTML = upload.active
    ? `<span>正在上传 ${esc(upload.file.name)} · ${upload.percent}%</span><progress class="upload-progress" max="100" value="${upload.percent}" aria-label="文件上传进度"></progress>`
    : upload.error ? `<span class="form-error" role="alert">${esc(upload.error)}</span><button class="btn btn-small" data-action="retry-upload">重新上传</button>` : '<span>文件已上传</span>';
}
async function uploadAttachment(file) {
  if (!file) return;
  if (state.upload?.active) return toast('当前文件正在上传，请等待完成。', true);
  if (file.size > 32 * 1024 * 1024) return toast('文件超过32 MB，请压缩后上传。', true);
  const extensions = ['pdf','doc','docx','xls','xlsx','csv','txt','html','zip','zcx','zgdxnzf','jpg','jpeg','png'];
  if (!extensions.includes(file.name.split('.').at(-1).toLowerCase())) return toast('请上传采购文件、表格、压缩包或图片。', true);
  const projectId = state.selected;
  if (!projectId) return;
  if ((projectById(projectId).attachments || []).some(a => a.name === file.name)
      && !window.confirm('项目中已有同名文件，继续上传这个文件吗？')) return;
  state.upload = { file, projectId, percent: 0, active: true, error: '' };
  renderUploadStatus();
  const fd = new FormData();
  fd.append('file', file);
  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API}/projects/${encodeURIComponent(projectId)}/attachments`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.timeout = 120000;
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) {
          state.upload.percent = Math.min(99, Math.round(event.loaded / event.total * 100));
          renderUploadStatus();
        }
      };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch (_) {}
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        if (xhr.status === 401) renderLogin();
        reject(new Error(data.error || '文件上传失败，请重试。'));
      };
      xhr.onerror = () => reject(new Error('网络连接中断，请重新上传。'));
      xhr.ontimeout = () => reject(new Error('上传超时，请重试。'));
      xhr.send(fd);
    });
    state.upload.active = false;
    state.upload.percent = 100;
    await load();
    toast('文件已上传');
  } catch (error) {
    state.upload.active = false;
    state.upload.error = error.message;
    renderUploadStatus();
    toast(error.message, true);
  }
}

async function discover(query) {
  if (state.discovering) return;
  state.discoverQuery = query.trim();
  if (!state.discoverQuery) return;
  state.discovering = true;
  renderDiscover();
  try { state.discovery = await api('/discover', { method: 'POST', body: JSON.stringify({ query: state.discoverQuery }) }); }
  catch (error) { state.discovery = { candidates: [], errors: [error.message] }; }
  finally { state.discovering = false; if (state.view === 'discover' && !document.body.classList.contains('signed-out')) renderDiscover(); }
}

async function importCandidate(index, button) {
  const candidate = (state.discovery.candidates || state.discovery.results || [])[index];
  if (!candidate) return;
  const source = candidate.source_url || candidate.url || candidate.link || '';
  const duplicate = state.data.projects.find(p => (source && p.source_url === source) || p.title === candidate.title);
  if (duplicate) { toast('该项目已在台账中'); return openProject(duplicate.id); }
  button.disabled = true;
  try {
    await api('/projects', { method: 'POST', body: JSON.stringify({ title: candidate.title || candidate.name, buyer: candidate.buyer || '', platform: candidate.platform || candidate.source || '', region: candidate.region || '', source_url: source, summary: candidate.summary || candidate.snippet || candidate.description || '', decision: '待评估', receipt_status: '未领取', stage: '线索', notes: '由公开公告检索加入，预算、资格、截止时间和 CA 要求待核实。', deadlines: [], materials: [], ca_ids: [] }) });
    await load();
    button.textContent = '已加入';
    toast('已加入台账，信息待核实');
  } catch (error) { button.disabled = false; toast(error.message, true); }
}

function navigate(view) {
  if (editor.open && !requestCloseEditor()) return;
  state.scroll[state.view] = window.scrollY;
  closeDrawer();
  state.view = view;
  render();
  requestAnimationFrame(() => window.scrollTo(0, Number(state.scroll[view]) || 0));
}
document.querySelector('#navigation').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button) navigate(button.dataset.view);
});

document.addEventListener('click', async event => {
  const button = event.target.closest('button, [data-action]');
  if (!button) return;
  if (button.dataset.action === 'toggle-pin') return changeProjectAction(button.dataset.projectId, 'pin');
  if (button.dataset.action === 'discard-project') return confirmDiscardProject(button.dataset.projectId, button);
  if (button.dataset.action === 'restore-project') return changeProjectAction(button.dataset.projectId, 'restore');
  if (button.dataset.action === 'cancel-discard') return closeProjectActionDialog();
  if (button.dataset.action === 'confirm-discard') {
    const id = button.dataset.projectId;
    closeProjectActionDialog();
    return changeProjectAction(id, 'discard');
  }
  if (button.dataset.open) return openProject(button.dataset.open);
  if (button.dataset.editProject) return editProject(button.dataset.editProject);
  if (button.dataset.editCa) return editCA(button.dataset.editCa);
  if (button.dataset.metric) { state.quick = button.dataset.metric; state.page = 1; return renderProjects(); }
  if (button.dataset.quick) { listFilters().quick = button.dataset.quick; listFilters().page = 1; return renderProjects(); }
  if (button.hasAttribute('data-expired-reason')) { state.expired.reason = button.dataset.expiredReason; state.expired.page = 1; return renderProjects(); }
  if (button.dataset.clearFilter) { listFilters()[button.dataset.clearFilter] = ''; listFilters().page = 1; return renderProjects(); }
  if (button.dataset.page) { listFilters().page = Number(button.dataset.page); return renderProjectResults(true); }
  if (button.dataset.tab) {
    state.detailTab = button.dataset.tab;
    renderDrawer();
    drawerRoot.querySelector(`[data-tab="${state.detailTab}"]`)?.focus();
    return;
  }
  if (button.hasAttribute('data-copy')) {
    try { await navigator.clipboard.writeText(button.dataset.copy); toast('已复制'); }
    catch (_) { toast('复制失败，请手动选择内容复制。', true); }
    return;
  }
  if (button.dataset.month) {
    const next = new Date(state.year, state.month + Number(button.dataset.month), 1);
    state.year = next.getFullYear(); state.month = next.getMonth(); return renderCalendar();
  }
  if (button.hasAttribute('data-remove-row')) { button.closest('.repeat-row, .material-editor-row')?.remove(); return; }
  if (button.dataset.searchTerm) return discover(button.dataset.searchTerm);
  if (button.hasAttribute('data-import')) return importCandidate(Number(button.dataset.import), button);
  const action = button.dataset.action;
  if (action === 'refresh') return load(true);
  if (action === 'new-project') return editProject();
  if (action === 'new-ca') return editCA();
  if (action === 'show-expired') return navigate('expired');
  if (action === 'close-drawer') return closeDrawer();
  if (action === 'close-editor') return requestCloseEditor();
  if (action === 'reset-filters') {
    Object.assign(listFilters(), { query: '', platform: '', stage: '', decision: '', reason: '', quick: 'all', page: 1 });
    return renderProjects();
  }
  if (action === 'calendar-history') { state.calendarHistory = !state.calendarHistory; saveViewState(); return renderCalendar(); }
  if (action === 'calendar-today') { const now = dayKey().split('-'); state.year = Number(now[0]); state.month = Number(now[1]) - 1; return renderCalendar(); }
  if (action === 'add-deadline') return document.querySelector('#deadline-editors').insertAdjacentHTML('beforeend', deadlineEditor({}, document.querySelectorAll('.deadline-editor').length));
  if (action === 'add-material') return document.querySelector('#material-editors').insertAdjacentHTML('beforeend', materialEditor());
  if (action === 'toggle-password') {
    const input = document.querySelector('#login-password');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? '隐藏' : '显示';
    button.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
    button.setAttribute('aria-pressed', String(show));
    return;
  }
  if (action === 'retry-upload' && state.upload?.projectId === state.selected) return uploadAttachment(state.upload.file);
  if (action === 'logout') {
    if (editor.open && !requestCloseEditor()) return;
    try { await api('/logout', { method: 'POST', body: '{}' }); state.data = { projects: [], cas: [], activity: [] }; state.pendingDrawer = null; closeDrawer(); renderLogin(); }
    catch (error) { toast(error.message, true); }
  }
});

document.addEventListener('input', event => {
  if (event.target.id === 'project-search') { listFilters().query = event.target.value; listFilters().page = 1; renderProjectResults(true); }
});
document.addEventListener('change', event => {
  const filterKeys = { 'platform-filter': 'platform', 'stage-filter': 'stage', 'decision-filter': 'decision' };
  if (filterKeys[event.target.id]) { listFilters()[filterKeys[event.target.id]] = event.target.value; listFilters().page = 1; renderProjectResults(true); }
  if (event.target.name === 'deadline-date-only') {
    const input = event.target.closest('.deadline-editor').querySelector('[name=deadline-at]');
    const value = input.value;
    input.type = event.target.checked ? 'date' : 'datetime-local';
    input.value = value ? event.target.checked ? value.slice(0, 10) : value.slice(0, 10) + 'T00:00' : '';
  }
  if (event.target.hasAttribute('data-material')) toggleMaterial(event.target);
  if (event.target.id === 'attachment-upload') uploadAttachment(event.target.files?.[0]);
});
document.addEventListener('dragover', event => {
  const zone = event.target.closest('.upload-zone');
  if (!zone) return;
  event.preventDefault();
  zone.classList.add('drag-over');
});
document.addEventListener('dragleave', event => {
  const zone = event.target.closest('.upload-zone');
  if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove('drag-over');
});
document.addEventListener('drop', event => {
  const zone = event.target.closest('.upload-zone');
  if (!zone) return;
  event.preventDefault();
  zone.classList.remove('drag-over');
  if (event.dataTransfer.files.length !== 1) return toast('请一次上传一个文件。', true);
  uploadAttachment(event.dataTransfer.files[0]);
});

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!['project-form', 'ca-form', 'discover-form', 'login-form'].includes(form.id)) return;
  event.preventDefault();
  if (form.id === 'project-form') return saveEditor(form, 'project');
  if (form.id === 'ca-form') return saveEditor(form, 'ca');
  if (form.id === 'discover-form') return discover(new FormData(form).get('query'));
  if (form.id === 'login-form') {
    const button = form.querySelector('[type=submit]');
    const values = new FormData(form);
    const username = String(values.get('username') || '').trim();
    const password = String(values.get('password') || '');
    button.disabled = true;
    button.textContent = '正在登录…';
    form.setAttribute('aria-busy', 'true');
    try {
      await api('/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      await load();
    } catch (error) {
      renderLogin(error.message, username);
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = '登录后台';
        form.removeAttribute('aria-busy');
      }
    }
  }
});

document.addEventListener('keydown', event => {
  if (['ArrowLeft', 'ArrowRight'].includes(event.key) && event.target.matches('.tab')) {
    const tabs = ['overview', 'planning', 'files'];
    const index = tabs.indexOf(state.detailTab);
    state.detailTab = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    renderDrawer();
    drawerRoot.querySelector(`[data-tab="${state.detailTab}"]`)?.focus();
    event.preventDefault();
    return;
  }
  if (event.key === 'Escape' && !editor.open && !projectActionDialog.open) closeDrawer();
  if (event.key === 'Tab' && state.selected && !editor.open && !projectActionDialog.open) {
    const nodes = [...drawerRoot.querySelectorAll('button, a[href], input:not([disabled])')].filter(n => n.offsetParent !== null);
    const first = nodes[0], last = nodes.at(-1);
    if (event.shiftKey && document.activeElement === first) { last?.focus(); event.preventDefault(); }
    else if (!event.shiftKey && document.activeElement === last) { first?.focus(); event.preventDefault(); }
  }
});

editor.addEventListener('click', event => { if (event.target === editor) requestCloseEditor(); });
editor.addEventListener('cancel', event => { event.preventDefault(); requestCloseEditor(); });
projectActionDialog.addEventListener('click', event => { if (event.target === projectActionDialog) closeProjectActionDialog(); });
projectActionDialog.addEventListener('cancel', event => { event.preventDefault(); closeProjectActionDialog(); });
window.addEventListener('beforeunload', event => { if (editor.open && editorInitial !== editorSnapshot()) { event.preventDefault(); event.returnValue = ''; } });
function refreshTimeState() {
  if (document.body.classList.contains('signed-out') || editor.open || projectActionDialog.open || pendingProjectActions.size || state.selected || state.upload?.active || state.discovering) return;
  if (['projects', 'expired', 'discarded'].includes(state.view) && main.contains(document.activeElement)) { updateNavigation(); renderProjectResults(); return; }
  const scroll = window.scrollY;
  render();
  window.scrollTo(0, scroll);
}
setInterval(refreshTimeState, 60000);
window.addEventListener('focus', refreshTimeState);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTimeState(); });
document.addEventListener('scroll', event => {
  if (!event.target.matches?.('.table-wrap')) return;
  state.scroll[state.view + '-table'] = { top: event.target.scrollTop, left: event.target.scrollLeft };
  saveViewState();
}, true);
document.querySelector('.topbar-right').insertAdjacentHTML('beforeend', '<button class="btn btn-quiet btn-small" data-action="logout">退出</button>');
restoreViewState();
load();
