import { CompanionClient } from '../lib/client.mjs';

// 配对 fragment 在任何交互或网络连接之前移除；凭据从不进入持久存储。
let initialPair = location.hash;
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
const $ = id => document.getElementById(id);
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') n.className = value;
    else if (key.startsWith('on')) n.addEventListener(key.slice(2), value);
    else n.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null) n.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return n;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name); svg.setAttribute('aria-hidden', 'true'); svg.append(use); return svg;
}
const btn = (text, fn, cls = '', id) => el('button', {type:'button', class:cls, ...(id ? {id} : {}), onclick:fn}, text);
const empty = text => el('p', {class:'empty'}, text);
const note = text => el('p', {class:'demo-note'}, text);
const title = text => el('h1', {}, text);
const section = (id, ...children) => el('section', {id, class:'page' + (id === 'home' ? ' active' : '')}, children);
function search(id, placeholder, fn) { return el('label', {class:'search'}, icon('search'), el('input', {id, type:'search', placeholder, 'aria-label':placeholder, oninput:fn})); }
const logo = () => el('img', {src:'assets/logo.png', alt:''});
const themeButton = id => btn(icon('moon'), toggleTheme, 'icon-btn', id);
const app = $('app');
app.replaceChildren(
  el('header', {class:'topbar'}, el('div', {class:'brand'}, logo(), 'DeepCompose'), el('div', {class:'top-actions'}, el('span', {class:'preview-pill', id:'connection-pill'}, '未配对'), themeButton('theme'))),
  el('main', {},
    section('home', title('接着写下去。'), el('p', {class:'subtitle'}, '作品留在电脑，灵感随身同行。'), btn([icon('pc'), el('span', {id:'connection-summary'}, '连接你的写作电脑'), icon('next')], () => page('profile'), 'connection'), el('div', {id:'home-content'}, empty('连接电脑后，在这里阅读作品和查看任务。'))),
    section('books', el('div', {id:'book-library'}, el('div', {class:'heading-row'}, title('我的作品'), btn('刷新', loadProjects, 'text-action', 'refresh-books')), el('p', {class:'subtitle'}, '从电脑读取的真实作品。'), search('book-search', '搜索作品', renderBooks), el('div', {id:'book-list'}, empty('请先连接写作电脑。'))),
      el('div', {id:'book-detail', class:'book-detail', hidden:''}, el('div', {class:'backline'}, btn([icon('back'), '作品列表'], () => { $('book-detail').hidden = true; $('book-library').hidden = false; })), el('h1', {id:'detail-title'}), el('p', {id:'detail-subtitle', class:'subtitle'}), el('div', {class:'tabs', 'aria-label':'作品内容'}, ...Object.entries({chapters:'章节', candidates:'候选', materials:'小说资料'}).map(([key,text]) => btn(text, () => openProject(selected, key), '', 'tab-' + key))), search('file-search', '搜索当前列表', renderFiles), el('div', {class:'file-create-actions'}, ...Object.entries({chapters:'新建正文',candidates:'新建候选',materials:'新建资料'}).map(([kind,label]) => btn(label, () => createFile(kind), 'secondary'))), el('p', {id:'file-action-status', class:'error-text', role:'status'}), el('div', {id:'detail-content'}))),
    section('chat', el('div', {class:'heading-row'}, title('AI 对话'), btn(icon('clock'), openSessions, 'icon-btn', 'sessions')), el('label', {class:'project-picker'}, '当前作品', el('select', {id:'chat-project', 'aria-label':'对话作品', onchange:updateControls})), note('手机会话独立保存，桌面历史只读'), el('div', {class:'chat-project'}, el('small', {id:'model-label'}, '连接后显示电脑现有模型')), el('p', {id:'task-summary', role:'status', 'aria-live':'polite'}, '尚未启动任务'), el('div', {id:'messages'}, empty('选择作品，和电脑上的模型开始一次对话。')), el('div', {id:'questions'}),
      el('div', {class:'composer'}, el('form', {id:'chat-form', class:'compose-box', onsubmit:startTask}, el('textarea', {id:'chat-input', 'aria-label':'给 AI 的指令', placeholder:'说说你的写作想法…', maxlength:'8000'}), el('div', {class:'compose-tools'}, el('select', {id:'chat-mode', 'aria-label':'AI 模式', onchange:modeHint}, el('option', {value:'readonly'}, '只读讨论'), el('option', {value:'writing'}, '生成新候选'), el('option', {value:'dev'}, '完整写作权限')), el('button', {id:'send', class:'send-btn', type:'submit', 'aria-label':'发送到电脑'}, icon('send')))), el('p', {id:'mode-hint', class:'demo-note'}, '只读讨论：读取资料并讨论，不修改作品。'), el('div', {class:'task-actions'}, btn('停止任务', stopTask, 'secondary', 'stop-task'), btn('刷新状态', () => fetchTask(), '', 'refresh-task')), note('离开页面或网络断开后，电脑仍会继续任务。'), el('p', {id:'chat-error', class:'error-text', role:'alert'}))),
    section('profile', title('连接写作电脑'), el('p', {class:'subtitle'}, '使用电脑连接进程提供的配对链接或配对码。'), el('div', {class:'connection'}, icon('pc'), el('span', {id:'device-label'}, '尚未配对')), el('form', {id:'pair-form', class:'pair-form', onsubmit:submitPair}, el('label', {for:'pair-input'}, '配对链接或配对码'), el('textarea', {id:'pair-input', rows:'4', autocomplete:'off', autocapitalize:'off', spellcheck:'false', placeholder:'粘贴完整配对链接或 43 位配对码'}), el('button', {id:'pair-submit', type:'submit', class:'primary'}, '连接电脑', icon('arrow'))), el('p', {id:'pair-error', class:'error-text', role:'alert'}), btn('断开并清除本页资料', disconnect, 'secondary', 'disconnect'), note('配对码仅在本页内存中使用，刷新后需重新配对。请只使用自己电脑提供的链接。'), el('div', {class:'settings-group'}, btn([icon('moon'), el('span', {}, '界面主题'), el('small', {id:'theme-name'}, '晨雾白'), icon('next')], toggleTheme, 'settings-row')))
  ),
  el('nav', {class:'bottomnav', 'aria-label':'主导航'}, ...[['home','home','工作台'],['books','book','作品'],['chat','chat','AI 对话'],['profile','pc','连接']].map(([id,i,text]) => { const b = btn([icon(i), text], () => page(id)); b.dataset.page = id; if(id === 'home') b.setAttribute('aria-current','page'); return b; }))
);
const reader = el('dialog', {id:'reader', class:'reader', 'aria-label':'阅读与编辑'}, el('header', {class:'reader-bar'}, btn(icon('back'), closeReader, 'icon-btn', 'close-reader'), el('span', {id:'reader-book'}), el('div', {class:'reader-tools'}, btn('Aa', () => { fontIndex = (fontIndex + 1) % 3; document.documentElement.style.setProperty('--read', [17,19,21][fontIndex] + 'px'); }, 'icon-btn'), themeButton('reader-theme'))), el('article', {}, el('span', {class:'tag'}, '只读'), el('h1', {id:'reader-title'}), el('div', {id:'reader-meta', class:'reader-meta'}), el('div', {id:'reader-prose', class:'prose'})), el('footer', {class:'reader-bottom'}, el('p', {id:'reader-status', class:'demo-note', role:'status', 'aria-live':'polite'}), el('div', {id:'reader-actions', class:'reader-actions'})));
const sheet = el('dialog', {id:'sheet', 'aria-label':'会话记录'}, el('div', {class:'sheet-head'}, el('h2', {}, '会话记录'), btn(icon('close'), () => sheet.close(), 'icon-btn')), el('div', {id:'sheet-content', class:'sheet-body'}));
document.body.append(reader, sheet);
let fontIndex = 0, readerFocus, readRequest = 0;
let readerFile = null, readerBusy = false;
const maxFileBytes = 2 * 1024 * 1024;
const editor = el('textarea', {id:'reader-editor', wrap:'soft', 'aria-label':'编辑全文', spellcheck:'false', hidden:'', oninput:updateReaderActions});
const editTools = el('div', {id:'edit-tools', class:'edit-tools', hidden:''}, btn('查找下一处', findInEditor, 'secondary'), btn('替换选区', replaceSelection, 'secondary'), btn('全选', () => { editor.focus(); editor.select(); }, 'secondary'));
$('reader-prose').after(editTools, editor);
reader.addEventListener('cancel', event => { event.preventDefault(); closeReader(); });
sheet.addEventListener('close', () => { readRequest++; });
window.addEventListener('beforeunload', event => { if(readerBusy || readerDirty()) { event.preventDefault(); event.returnValue = ''; } });
let client = null, connection = 'closed', hello = null, generation = 0;
let projects = [], selected = null, category = 'chapters', files = [], fileRequest = 0;
let taskId = '', task = null, polling = null, pollBusy = false, sending = false, actionBusy = false, uncertain = false;
let questionKey = '';
try { taskId = sessionStorage.getItem('dc-mobile-task') || ''; } catch {}
function storeTask() { try { taskId ? sessionStorage.setItem('dc-mobile-task', taskId) : sessionStorage.removeItem('dc-mobile-task'); } catch {} }
function page(id) {
  if(reader.open && !closeReader()) return;
  document.querySelectorAll('.page').forEach(n => n.classList.toggle('active', n.id === id));
  document.querySelectorAll('[data-page]').forEach(n => { if(n.dataset.page === id) n.setAttribute('aria-current','page'); else n.removeAttribute('aria-current'); });
  window.scrollTo(0,0);
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme-name').textContent = dark ? '曜石黑' : '晨雾白';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#111214' : '#f4f5f6';
  try { localStorage.setItem('dc-preview-theme', dark ? 'dark' : 'light'); } catch {}
}
try { if(localStorage.getItem('dc-preview-theme') === 'dark') toggleTheme(); } catch {}
function parsePair(raw) {
  let value = raw.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    const hash = value.includes('#') ? value.slice(value.indexOf('#') + 1) : value.replace(/^#/, '');
    value = new URLSearchParams(hash).get('pair') || '';
  }
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}
function errorText(error) {
  // 不回显任意异常文本，避免底层网络错误携带配对链接或配置。
  const code = String(error?.code || error?.message || '');
  if (/busy/i.test(code)) return '电脑已有任务运行，请等待完成后再试。';
  if (/timeout/i.test(code)) return '电脑响应超时，请检查电脑连接。';
  if (/not.?found/i.test(code)) return '内容已不存在，请刷新列表。';
  return connection !== 'connected' ? '电脑离线或尚未连接，请检查电脑连接进程。' : '操作未完成，请检查电脑状态后重试。';
}
async function rpc(method, params = {}) {
  const c = client, epoch = generation;
  if (!c || connection !== 'connected') throw new Error('offline');
  const result = await c.request(method, params);
  if(c !== client || epoch !== generation) throw new Error('stale');
  return result;
}
function updateConnection(state) {
  connection = state;
  const labels = {closed:'未配对', connecting:'连接中', connected:'已连接', offline:'电脑离线'};
  $('connection-pill').textContent = labels[state] || '电脑离线';
  $('connection-summary').textContent = state === 'connected' ? (hello?.device || '写作电脑') + ' · 已连接' : state === 'closed' ? '连接你的写作电脑' : labels[state] + ' · 点击查看';
  $('device-label').textContent = hello ? [hello.device, hello.version, labels[state]].filter(Boolean).join(' · ') : labels[state];
  $('disconnect').disabled = !client;
  updateControls();
  if(state !== 'connected') clearTimeout(polling);
  renderHome();
}
async function submitPair(event) {
  event.preventDefault(); let secret = parsePair($('pair-input').value); $('pair-input').value = '';
  if(!secret) { $('pair-error').textContent = '请输入完整配对链接或 43 位配对码。'; return; }
  connect(secret); secret = '';
}
async function connect(secret) {
  if(!allowReaderLeave()) return;
  // 新配对先丢弃上一台电脑的可见明文，恢复标识仅保留当前页的任务 ID。
  const restoreId = taskId; reset(false); taskId = restoreId;
  const epoch = generation;
  $('pair-error').textContent = '';
  let c;
  c = new CompanionClient(secret, {onState: state => {
    if(epoch !== generation) return;
    updateConnection(state);
    if(state === 'connected') {
      if(hello) { $('pair-error').textContent = ''; loadProjects(); fetchTask(); }
      else if(c) c.request('hello').then(info => {
        if(epoch !== generation || client !== c) return;
        hello = info; updateConnection('connected'); $('pair-error').textContent = '';
        $('model-label').textContent = info.configured === false ? '电脑尚未配置模型' : '电脑模型 · ' + (typeof info.model === 'string' ? info.model : info.model?.name || info.model?.id || '由电脑配置');
        loadProjects(); fetchTask();
      }).catch(() => {});
    }
  }});
  secret = ''; client = c; updateConnection('connecting');
  try {
    const value = await c.connect();
    if(epoch !== generation || c !== client) return;
    hello = value; updateConnection('connected');
    $('model-label').textContent = value.configured === false ? '电脑尚未配置模型' : '电脑模型 · ' + (typeof value.model === 'string' ? value.model : value.model?.name || value.model?.id || '由电脑配置');
    await loadProjects(); if(taskId) fetchTask();
  } catch(error) { if(epoch === generation) { updateConnection('offline'); $('pair-error').textContent = errorText(error) + ' 将自动尝试重连。'; } }
}
function reset(forgetTask = true) {
  readerFile = null; readerBusy = false; editor.value = ''; editor.hidden = true; editTools.hidden = true;
  generation++; const old = client; client = null; old?.close(); clearTimeout(polling);
  readRequest++; readerFocus = null; hello = null; projects = []; selected = null; files = []; task = null; questionKey = ''; sending = false; actionBusy = false; uncertain = false; pollBusy = false; fileRequest++;
  if(forgetTask) { taskId = ''; storeTask(); }
  $('pair-input').value = ''; $('chat-input').value = ''; $('book-search').value = ''; $('file-search').value = '';
  $('pair-error').textContent = ''; $('chat-error').textContent = ''; $('detail-title').textContent = ''; $('detail-subtitle').textContent = ''; $('detail-content').replaceChildren();
  $('book-detail').hidden = true; $('book-library').hidden = false;
  reader.close(); sheet.close(); ['reader-book','reader-title','reader-meta','reader-prose','sheet-content','questions'].forEach(id => $(id).replaceChildren());
  $('messages').replaceChildren(empty('选择作品，和电脑上的模型开始一次对话。')); $('model-label').textContent = '连接后显示电脑现有模型'; $('task-summary').textContent = '尚未启动任务';
  updateConnection('closed'); renderBooks(); renderHome(); renderProjectPicker();
}
function disconnect() { if(!allowReaderLeave()) return; reset(); page('profile'); }
function row(name, meta, fn, cover = false) {
  return btn([...(cover ? [el('span', {class:'mini-cover'}, String(name).slice(0,10))] : []), el('span', {class:'row-copy'}, el(cover ? 'h2' : 'p', {}, name), el('small', {}, meta)), icon('next')], fn, cover ? 'book-list-item' : 'chapter-row');
}
function date(value) { const d = new Date(value); return value && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('zh-CN') : ''; }
async function loadProjects() {
  if(connection !== 'connected') { renderBooks(); return; }
  const epoch = generation;
  $('book-list').replaceChildren(empty('正在读取作品…'));
  try {
    const value = await rpc('projects.list');
    projects = Array.isArray(value) ? value : [];
    if(selected) selected = projects.find(p => p.id === selected.id) || null;
    if(!selected && hello?.currentProjectId) selected = projects.find(p => p.id === hello.currentProjectId) || null;
    renderBooks(); renderHome(); renderProjectPicker();
  } catch(error) { if(epoch === generation) $('book-list').replaceChildren(empty(errorText(error)), btn('重新读取', loadProjects, 'secondary')); }
}
function renderProjectPicker() {
  const current = $('chat-project').value;
  $('chat-project').replaceChildren(...(projects.length ? projects.map(p => el('option', {value:p.id}, p.name)) : [el('option', {value:''}, client ? '电脑暂无作品' : '请先连接电脑')]));
  if(projects.some(p => p.id === current)) $('chat-project').value = current;
  else if(hello?.currentProjectId && projects.some(p => p.id === hello.currentProjectId)) $('chat-project').value = hello.currentProjectId;
  if(task && projects.some(p => p.id === task.projectId)) $('chat-project').value = task.projectId;
  updateControls();
}
function renderBooks() {
  const term = $('book-search').value.trim().toLocaleLowerCase();
  const list = projects.filter(p => String(p.name).toLocaleLowerCase().includes(term));
  $('book-list').replaceChildren(...(list.length ? list.map(p => row(p.name, [p.chapterCount != null ? p.chapterCount + ' 章正文' : '', p.candidateCount != null ? p.candidateCount + ' 份候选' : '', date(p.modifiedAt)].filter(Boolean).join(' · '), () => openProject(p), true)) : [empty(client ? projects.length ? '没有匹配的作品。' : '电脑暂无已授权作品。' : '请先连接写作电脑。')]));
}
function renderHome() {
  const root = $('home-content'); root.replaceChildren();
  if(!projects.length) { root.append(empty(client ? '电脑暂无作品，或尚未成功读取。' : '连接电脑后，在这里阅读作品和查看任务。'), btn('连接写作电脑', () => page('profile'), 'secondary')); return; }
  const p = selected || projects[0];
  root.append(el('div', {class:'book-hero'}, el('small', {}, '电脑作品'), el('div', {class:'booktitle'}, p.name), el('p', {class:'bookmeta'}, [p.chapterCount != null ? p.chapterCount + ' 章正文' : '', p.candidateCount != null ? p.candidateCount + ' 份候选' : ''].filter(Boolean).join(' · ')), el('div', {class:'hero-bottom'}, btn('阅读章节', () => openProject(p), 'light-btn'), btn('查看候选', () => openProject(p,'candidates'), 'light-btn'))), el('div', {class:'section-head'}, el('h2', {}, '写作电脑')), note(connection === 'connected' ? '已连接 · 阅读与生成由电脑提供' : '电脑离线 · 页面已读取内容可继续浏览'), btn('查看手机任务', () => page('chat'), 'task-row'));
}
async function openProject(project, tab = 'chapters') {
  if(!project) return; selected = project; category = tab; files = []; const request = ++fileRequest;
  page('books'); $('book-library').hidden = true; $('book-detail').hidden = false;
  $('detail-title').textContent = project.name; $('detail-subtitle').textContent = '电脑作品 · 阅读与编辑'; $('file-search').value = '';
  for(const key of ['chapters','candidates','materials']) { $('tab-' + key).classList.toggle('selected', key === tab); $('tab-' + key).setAttribute('aria-pressed', String(key === tab)); }
  $('detail-content').replaceChildren(empty('正在读取列表…'));
  try { const value = await rpc('files.list', {projectId:project.id, category:tab}); if(request !== fileRequest) return; files = Array.isArray(value) ? value : []; renderFiles(); }
  catch(error) { if(request === fileRequest) $('detail-content').replaceChildren(empty(errorText(error)), btn('重新读取', () => openProject(project,tab), 'secondary')); }
}
function renderFiles() {
  const term = $('file-search').value.trim().toLocaleLowerCase();
  const list = files.filter(f => String(f.name).toLocaleLowerCase().includes(term));
  $('detail-content').replaceChildren(...(list.length ? list.map(f => row(f.name, [{chapters:'正文', candidates:'候选', materials:'小说资料'}[category], f.size != null ? Math.ceil(f.size / 1024) + ' KB' : '', date(f.modifiedAt)].filter(Boolean).join(' · '), () => readFile(selected, f))) : [empty(term ? '没有匹配的文件。' : {chapters:'还没有章节。',candidates:'暂无候选稿。',materials:'暂无小说资料。'}[category])]));
}
function readerDirty() { return !!readerFile && !editor.hidden && editor.value !== readerFile.content; }
function readerStatus(text) { $('reader-status').textContent = text; }
function allowReaderLeave() {
  if(readerBusy) { readerStatus('正在提交到电脑，请等待操作完成。'); return false; }
  return !readerDirty() || confirm('有尚未保存的修改。确定放弃本页草稿？');
}
function showReader(book, name, content, meta) {
  readRequest++;
  if(!reader.open) readerFocus = document.activeElement;
  readerFile = null; editor.hidden = true; editTools.hidden = true; editor.value = '';
  $('reader-prose').hidden = false;
  $('reader-book').textContent = book; $('reader-title').textContent = name;
  $('reader-meta').textContent = meta; $('reader-prose').textContent = content;
  readerStatus(''); updateReaderActions();
  if(!reader.open) reader.showModal(); reader.scrollTop = 0;
}
function closeReader() {
  if(!allowReaderLeave()) return false;
  readRequest++; reader.close(); readerFile = null; editor.value = ''; readerFocus?.focus(); return true;
}
function updateReaderActions() {
  const f = readerFile, editing = !editor.hidden, online = connection === 'connected';
  reader.querySelector('article>.tag').textContent = f ? ({chapters:'正文',candidates:'候选',materials:'小说资料'}[f.category] || '文件') : '只读';
  $('close-reader').disabled = readerBusy; editor.readOnly = readerBusy;
  editTools.querySelectorAll('button').forEach(b => b.disabled = readerBusy);
  const actions = [];
  function action(text, fn, disabled, primary = false) { const b = btn(text, fn, primary ? 'primary' : 'secondary'); b.disabled = !!disabled; actions.push(b); }
  action(editing ? '复制草稿' : '复制全文', copyReader, readerBusy || (f ? !f.complete : !$('reader-prose').textContent));
  if(f) {
    if(editing) {
      action('取消编辑', cancelEdit, readerBusy);
      action(readerBusy ? '保存中…' : '保存到电脑', saveReader, readerBusy || !online || !readerDirty(), true);
    } else {
      action('编辑', startEdit, readerBusy || !f.complete || !f.version);
      if(f.category === 'candidates') {
        action('采用并回写', adoptCandidate, readerBusy || !online || !f.complete || activeTask() || uncertain);
      }
      if(['chapters','candidates'].includes(f.category)) action('回流', reflowReader, readerBusy || !online || !f.complete || activeTask() || uncertain);
    }
  }
  $('reader-actions').replaceChildren(...actions);
}
function startEdit() {
  if(readerBusy || !readerFile?.complete || !readerFile.version) return;
  editor.value = readerFile.content; editor.hidden = false; editTools.hidden = false; $('reader-prose').hidden = true;
  readerStatus('修改保留在本页，点击保存才会写入电脑。'); updateReaderActions(); editor.focus();
}
function cancelEdit() {
  if(!allowReaderLeave()) return;
  editor.hidden = true; editTools.hidden = true; editor.value = ''; $('reader-prose').hidden = false;
  readerStatus('已取消编辑。'); updateReaderActions();
}
function findInEditor() {
  if(readerBusy) return;
  const term = prompt('查找文字'); if(!term) return;
  let at = editor.value.indexOf(term, editor.selectionEnd);
  if(at < 0) at = editor.value.indexOf(term);
  if(at < 0) { readerStatus('没有找到这段文字。'); return; }
  editor.focus(); editor.setSelectionRange(at, at + term.length); readerStatus('已选中匹配文字，可点“替换选区”。');
}
function replaceSelection() {
  if(readerBusy) return;
  if(editor.selectionStart === editor.selectionEnd) { findInEditor(); return; }
  const text = prompt('将当前选区替换为（可留空删除）'); if(text === null) return;
  editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'select'); editor.focus(); updateReaderActions();
}
async function copyReader() {
  if(readerBusy || (readerFile && !readerFile.complete)) return;
  const text = editor.hidden ? (readerFile?.content ?? $('reader-prose').textContent) : editor.value;
  // 此函数只由按钮点击调用；不在加载、轮询或保存后自动访问剪贴板。
  const fallback = () => {
    const copy = el('textarea', {class:'copy-buffer', 'aria-label':'待复制全文', wrap:'soft'});
    copy.value = text; reader.append(copy); copy.focus(); copy.select(); copy.setSelectionRange(0, text.length);
    let ok; try { ok = document.execCommand('copy'); } finally { copy.remove(); }
    if(!editor.hidden) editor.focus();
    if(!ok) throw new Error('clipboard');
  };
  try {
    if(navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); } catch { fallback(); } }
    else fallback();
    readerStatus('已复制全文。');
  } catch { readerStatus('复制未完成。可进入编辑后全选，使用系统复制。'); }
}
async function loadFullFile(projectId, fileId, isCurrent = () => true) {
  let value;
  try { value = await rpc('file.chunk', {projectId,fileId,offset:0}); }
  catch(error) {
    if(!/method.?not.?found|unknown.?method|unsupported|not.?implemented/i.test(String(error?.code || error?.message || ''))) throw error;
    const legacy = await rpc('file.read', {projectId,fileId});
    return {...legacy, complete:!legacy.truncated};
  }
  const first = value, parts = []; let bytes = 0, offset = 0;
  while(true) {
    if(!isCurrent()) throw new Error('stale');
    if(value.version !== first.version || typeof value.content !== 'string') throw new Error('VERSION_CONFLICT');
    bytes += new TextEncoder().encode(value.content).length;
    if(bytes > maxFileBytes) throw new Error('FILE_TOO_LARGE');
    parts.push(value.content);
    if(value.nextOffset === null) break;
    if(!Number.isSafeInteger(value.nextOffset) || value.nextOffset <= offset) throw new Error('INVALID_CHUNK');
    offset = value.nextOffset;
    value = await rpc('file.chunk', {projectId,fileId,offset,version:first.version});
  }
  return {...first, content:parts.join(''), complete:true, truncated:false};
}
function fileError(error) {
  const code = String(error?.code || error?.message || '');
  if(/VERSION_CONFLICT|version.?conflict/i.test(code)) return '电脑上的文件已更新，未覆盖新版本。草稿仍在本页，可先复制再重新打开文件。';
  if(/FILE_TOO_LARGE|too.?large|limit/i.test(code)) return '全文超过 2 MiB，无法在手机保存；草稿仍保留，可复制后到电脑处理。';
  return errorText(error);
}
async function readFile(project, file) {
  if(!allowReaderLeave()) return;
  const epoch = generation, fileCategory = file.category || category;
  showReader(project.name, file.name, '正在加载全文…', '全文加载完成后可复制与编辑');
  const request = readRequest;
  readerFile = {projectId:project.id,fileId:file.id,category:fileCategory,content:'',complete:false}; updateReaderActions();
  const current = () => epoch === generation && request === readRequest && reader.open;
  try {
    const value = await loadFullFile(project.id, file.id, current); if(!current()) return;
    readerFile = {...readerFile,...value,fileId:file.id,projectId:project.id,category:value.category || fileCategory};
    $('reader-title').textContent = value.name || file.name; $('reader-prose').textContent = value.content;
    $('reader-meta').textContent = value.complete ? '全文已加载 · ' + (value.version || '') : '旧版电脑仅返回部分正文';
    readerStatus(value.complete ? '' : '未加载全文，复制与编辑不可用。请更新电脑连接进程。'); updateReaderActions();
  } catch(error) {
    if(current()) { $('reader-prose').textContent = fileError(error); readerStatus('全文加载未完成，请关闭后重试。'); updateReaderActions(); }
  }
}
function splitFileChunks(text) {
  const chunks = [];
  for(let at = 0; at < text.length;) {
    let end = Math.min(at + 16000, text.length);
    if(end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    chunks.push(text.slice(at,end)); at = end;
  }
  return chunks.length ? chunks : [''];
}
async function saveReader() {
  const f = readerFile; if(readerBusy || !f?.complete || !readerDirty() || connection !== 'connected') return;
  const content = editor.value, bytes = new TextEncoder().encode(content).length;
  if(bytes > maxFileBytes) { readerStatus(fileError(new Error('FILE_TOO_LARGE'))); return; }
  const chunks = splitFileChunks(content), epoch = generation;
  readerBusy = true; readerStatus('正在保存到电脑…'); updateReaderActions();
  try {
    const {uploadId} = await rpc('file.write.begin', {projectId:f.projectId,fileId:f.fileId,version:f.version,totalChunks:chunks.length,bytes});
    for(let index = 0; index < chunks.length; index++) await rpc('file.write.chunk', {projectId:f.projectId,uploadId,index,content:chunks[index]});
    const value = await rpc('file.write.commit', {projectId:f.projectId,uploadId,version:f.version});
    if(epoch !== generation || readerFile !== f) return;
    // 本页提交的完整草稿即保存后的全文；commit 返回的是首片，不能用它覆盖全文。
    f.content = content; f.version = value.version; f.name = value.name || f.name;
    $('reader-prose').textContent = content; $('reader-meta').textContent = '已保存 · ' + (f.version || '');
    editor.hidden = true; editTools.hidden = true; $('reader-prose').hidden = false;
    readerStatus(value.warning === 'BACKUP_METADATA_FAILED' ? '正文已保存，回流编辑基线未登记' : '已保存到电脑。');
    const cached = files.find(item => item.id === f.fileId); if(cached) { cached.size = bytes; cached.version = f.version; renderFiles(); }
  } catch(error) { if(epoch === generation) readerStatus(fileError(error) + ' 未自动重试，草稿仍保留。'); }
  finally { if(epoch === generation) { readerBusy = false; updateReaderActions(); } }
}
async function createFile(kind) {
  if(connection !== 'connected' || !selected || readerBusy) return;
  const entered = prompt('输入文件名（单层 .md 文件，例如：第001章.md）'); if(entered === null) return;
  let name = entered.trim(); if(!/\.md$/i.test(name)) name += '.md';
  if(!name || name === '.md' || /[\/\\:\x00-\x1f]/.test(name) || name.startsWith('.') || name.includes('..') || name.length > 180) { $('file-action-status').textContent = '请使用普通文件名，不含路径、冒号或连续点，长度不超过 180 字符。'; return; }
  const project = selected, epoch = generation, request = readRequest;
  const buttons = document.querySelectorAll('.file-create-actions button'); buttons.forEach(b => b.disabled = true);
  $('file-action-status').textContent = '正在新建…';
  try {
    const value = await rpc('file.create', {projectId:project.id,category:kind,name,content:''});
    if(epoch !== generation) return;
    // 新建等待期间用户可能打开了别的文件；不跳转或重置后来输入的草稿。
    if(request !== readRequest || readerBusy || readerDirty()) { $('file-action-status').textContent = '已新建，请刷新列表后打开。'; return; }
    await openProject(project,kind); $('file-action-status').textContent = '已新建，可开始编辑。';
    await readFile(project,{...value,category:kind});
    if(readerFile?.complete && readerFile.fileId === value.id && readerFile.projectId === project.id && !readerDirty()) startEdit();
  } catch(error) { if(epoch === generation) $('file-action-status').textContent = fileError(error); }
  finally { if(epoch === generation) buttons.forEach(b => b.disabled = connection !== 'connected'); }
}
async function showOperationTask(result, projectId) {
  if(!result?.taskId) throw new Error('INVALID_TASK');
  taskId = result.taskId; storeTask(); task = null; questionKey = ''; uncertain = false;
  $('questions').replaceChildren(); $('chat-error').textContent = ''; $('chat-project').value = projectId;
  readerBusy = false; closeReader(); page('chat'); $('task-summary').textContent = '任务已提交，等待电脑处理…';
  updateControls(); await fetchTask();
}
async function adoptCandidate() {
  const f = readerFile; if(readerBusy || !f?.complete || f.category !== 'candidates' || activeTask()) return;
  const epoch = generation; readerBusy = true; updateReaderActions(); readerStatus('正在核对采用落点…');
  try {
    const preview = await rpc('candidate.preview', {projectId:f.projectId,fileId:f.fileId,version:f.version});
    const details = ['将候选“' + (preview.sourceName || f.name) + '”采用到：' + preview.targetName,
      preview.existing ? '目标章节已存在，AI 将检查并处理已有正文，修改用户原文须先提问。' : '目标章节尚不存在，将由电脑创建。',
      '电脑 AI 将执行：登记 → 正文 → 追踪表 → 归档 → 推进章节。任务可能提问，请到对话页回答。',
      ...(Array.isArray(preview.warnings) ? preview.warnings : [])].join('\n\n');
    if(!confirm(details + '\n\n确认采用并回写？')) { readerStatus('已取消采用。'); return; }
    readerStatus('正在提交采用任务…');
    const result = await rpc('candidate.adopt', {projectId:f.projectId,fileId:f.fileId,version:f.version,token:preview.token});
    if(epoch === generation) await showOperationTask(result,f.projectId);
  } catch(error) { if(epoch === generation) {
    uncertain = !/busy|invalid|forbidden|conflict|not.?found/i.test(String(error?.code || error?.message || ''));
    readerStatus(fileError(error) + (uncertain ? ' 提交结果未知，已暂停再次提交。请在电脑或会话记录核对，重新配对后继续。' : '')); updateControls();
  } }
  finally { if(epoch === generation) { readerBusy = false; updateReaderActions(); } }
}
async function reflowReader() {
  const f = readerFile; if(readerBusy || !f?.complete || activeTask()) return;
  const choice = prompt('选择回流内容：1 事实资料；2 文风；3 两者', '3'); if(choice === null) return;
  const track = {'1':'facts','2':'style','3':'both'}[choice.trim()];
  if(!track) { readerStatus('请输入 1、2 或 3。'); return; }
  if(!confirm('将“' + f.name + '”的' + {facts:'事实资料',style:'文风',both:'事实资料与文风'}[track] + '回流到当前作品。电脑 AI 将执行资料更新，可能需要回答问题。确认提交？')) return;
  const epoch = generation; readerBusy = true; updateReaderActions(); readerStatus('正在提交回流任务…');
  try {
    const result = await rpc('file.reflow', {projectId:f.projectId,fileId:f.fileId,version:f.version,track});
    if(epoch === generation) await showOperationTask(result,f.projectId);
  } catch(error) { if(epoch === generation) {
    uncertain = !/busy|invalid|forbidden|conflict|not.?found/i.test(String(error?.code || error?.message || ''));
    readerStatus(fileError(error) + (uncertain ? ' 提交结果未知，已暂停再次提交。请在电脑或会话记录核对，重新配对后继续。' : '')); updateControls();
  } }
  finally { if(epoch === generation) { readerBusy = false; updateReaderActions(); } }
}
async function openSessions() {
  const projectId = $('chat-project').value; if(!projectId) { page('profile'); return; }
  const epoch = generation; $('sheet-content').replaceChildren(empty('正在读取会话…')); sheet.showModal();
  try { const list = await rpc('sessions.list', {projectId}); if(epoch !== generation || !sheet.open) return; $('sheet-content').replaceChildren(note('手机会话独立保存，桌面历史只读'), ...(list.length ? list.map(s => row(s.title || '未命名会话', (s.source === 'desktop' ? '桌面历史 · 只读' : '手机会话 · 只读记录') + ' · ' + date(s.updatedAt), () => readSession(projectId, s))) : [empty('暂无会话记录。')])); }
  catch(error) { if(epoch === generation) $('sheet-content').replaceChildren(empty(errorText(error))); }
}
async function readSession(projectId, session) {
  if(readerBusy || readerDirty() || !sheet.open) return;
  const epoch = generation, request = ++readRequest;
  const current = () => epoch === generation && request === readRequest && sheet.open && !readerBusy && !readerDirty();
  // 返回时只丢弃过期响应；不得在后台弹确认框或覆盖新打开的编辑器。
  try { const value = await rpc('session.read', {projectId, sessionId:session.id}); if(!current()) return; sheet.close(); showReader(projects.find(p => p.id === projectId)?.name || '', value.title, (value.messages || []).map(m => (m.role === 'user' ? '你' : 'DeepCompose') + '\n' + m.text).join('\n\n'), '历史会话 · 只读'); }
  catch(error) { if(current()) $('sheet-content').replaceChildren(empty(errorText(error))); }
}
function activeTask() { return !!taskId && (!task || ['running','waiting'].includes(task.state)); }
function updateControls() {
  const online = connection === 'connected'; const active = activeTask();
  $('send').disabled = !online || hello?.configured === false || !projects.length || ! $('chat-project').value || active || sending || uncertain;
  $('stop-task').disabled = !online || !taskId || !active || actionBusy;
  $('refresh-task').disabled = !online || !taskId;
  $('chat-project').disabled = active || sending;
  $('chat-mode').disabled = active || sending;
  $('pair-submit').disabled = connection === 'connecting' || readerBusy;
  document.querySelectorAll('.file-create-actions button').forEach(b => b.disabled = !online || readerBusy);
  updateReaderActions();
}
function modeHint() { $('mode-hint').textContent = {readonly:'只读讨论：读取资料并讨论，不修改作品。',writing:'仅生成新候选：不覆盖正式稿、资料或既有候选。可在候选页采用并回写。',dev:'完整写作权限：可编辑当前作品正文与资料、归档候选；写前备份，修改用户原文须先提问。'}[$('chat-mode').value]; }
async function startTask(event) {
  event.preventDefault(); if($('send').disabled) return;
  const text = $('chat-input').value.trim(); if(!text) { $('chat-input').focus(); return; }
  const projectId = $('chat-project').value, mode = ['writing','dev'].includes($('chat-mode').value) ? $('chat-mode').value : 'readonly';
  const epoch = generation; sending = true; $('chat-error').textContent = ''; $('task-summary').textContent = '正在向电脑提交…'; updateControls();
  try {
    const value = await rpc('task.start', {projectId,text,mode});
    if(epoch !== generation) return;
    taskId = value.taskId; storeTask(); task = null; questionKey = ''; $('chat-input').value = ''; $('questions').replaceChildren();
    await fetchTask();
  } catch(error) {
    if(epoch !== generation) return;
    // 无法判定是否已到达电脑时禁止再次提交；用户从会话记录核对后重新配对。
    uncertain = !/busy|invalid|forbidden/i.test(String(error?.code || error?.message || ''));
    $('chat-error').textContent = errorText(error) + (uncertain ? ' 本次提交结果未知，未自动重试。请在电脑或会话记录中确认，重新配对后再发送。' : '');
    $('task-summary').textContent = uncertain ? '提交结果未知' : '任务未启动';
  } finally { if(epoch === generation) { sending = false; updateControls(); } }
}
function schedulePoll() {
  clearTimeout(polling);
  if(!document.hidden && connection === 'connected' && activeTask()) polling = setTimeout(() => fetchTask(), 1500);
}
async function fetchTask() {
  if(!taskId || connection !== 'connected' || document.hidden || pollBusy) return;
  const id = taskId, epoch = generation; pollBusy = true; clearTimeout(polling);
  try {
    const value = await rpc('task.get', {taskId:id});
    if(epoch !== generation || id !== taskId) return;
    task = value; renderTask();
  } catch(error) { if(epoch === generation) $('chat-error').textContent = errorText(error) + ' 电脑任务不会因此取消。'; }
  finally { if(epoch === generation) { pollBusy = false; updateControls(); schedulePoll(); } }
}
function renderTask() {
  const states = {running:'电脑正在处理', waiting:'等待你的回答', completed:'任务已完成', failed:'任务失败', stopped:'任务已停止'};
  $('task-summary').textContent = states[task.state] || '正在恢复任务';
  $('chat-error').textContent = task.error ? (typeof task.error === 'string' ? task.error : task.error.message || '任务执行失败') : '';
  const messages = (task.messages || []).filter(m => ['user','assistant'].includes(m.role));
  $('messages').replaceChildren(...(messages.length ? messages.map(m => el('div', {class:'message' + (m.role === 'user' ? ' user' : '')}, ...(m.role === 'assistant' ? [el('div', {class:'assistant-label'}, logo(), 'DeepCompose')] : []), el('p', {class:'message-text'}, m.text))) : [empty(task.text || '电脑正在准备回复…')]));
  if(task.toolStatus) $('messages').append(el('div', {class:'tool-status'}, typeof task.toolStatus === 'string' ? task.toolStatus : JSON.stringify(task.toolStatus)));
  if(task.question && task.state === 'waiting') renderQuestion(task.question);
  else { questionKey = ''; $('questions').replaceChildren(); }
  if(task.projectId && projects.some(p => p.id === task.projectId)) $('chat-project').value = task.projectId;
}
function renderQuestion(question) {
  if(questionKey === question.id) return; questionKey = question.id;
  const items = Array.isArray(question.items) ? question.items : [];
  const answers = items.map(() => []);
  const form = el('form', {class:'question-block'});
  items.forEach((item,index) => {
    const group = el('fieldset', {}, el('legend', {}, item.question || '请选择'));
    for(const option of item.options || []) {
      const input = el('input', {type:item.multi_select ? 'checkbox' : 'radio', name:'question-' + index, value:option.label, onchange:() => {
        answers[index] = [...group.querySelectorAll('input:checked')].map(n => n.value);
      }});
      group.append(el('label', {class:'question-option'}, input, el('span', {}, el('span', {}, option.label), option.description ? el('small', {}, option.description) : null)));
    }
    form.append(group);
  });
  const submit = el('button', {type:'submit', class:'primary'}, '提交回答');
  const status = el('p', {class:'error-text', role:'alert'}); form.append(submit,status);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if(submit.disabled) return;
    if(answers.some(a => !a.length)) { status.textContent = '请回答每一道问题。'; return; }
    const epoch = generation; submit.disabled = true;
    try { await rpc('task.answer', {taskId,questionId:question.id,answers}); if(epoch === generation) { $('questions').replaceChildren(); questionKey = ''; await fetchTask(); } }
    catch(error) { if(epoch === generation) { status.textContent = errorText(error); submit.disabled = false; } }
  });
  $('questions').replaceChildren(form);
}
async function stopTask() {
  if($('stop-task').disabled) return; const epoch = generation; actionBusy = true; updateControls();
  try { await rpc('task.stop', {taskId}); if(epoch === generation) await fetchTask(); }
  catch(error) { if(epoch === generation) $('chat-error').textContent = errorText(error); }
  finally { if(epoch === generation) { actionBusy = false; updateControls(); } }
}
document.addEventListener('visibilitychange', () => { if(document.hidden) clearTimeout(polling); else fetchTask(); });
window.addEventListener('pageshow', () => fetchTask());
window.addEventListener('hashchange', () => {
  let fragment = location.hash; history.replaceState(null,'',location.pathname + location.search);
  let secret = parsePair(fragment); fragment = ''; if(secret) connect(secret); secret = '';
});
renderProjectPicker(); updateControls();
if(initialPair) { let secret = parsePair(initialPair); initialPair = ''; if(secret) connect(secret); else { page('profile'); $('pair-error').textContent = '配对链接格式不正确，请重新粘贴。'; } secret = ''; }
