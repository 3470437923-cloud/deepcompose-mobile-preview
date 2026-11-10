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
      el('div', {id:'book-detail', class:'book-detail', hidden:''}, el('div', {class:'backline'}, btn([icon('back'), '作品列表'], () => { $('book-detail').hidden = true; $('book-library').hidden = false; })), el('h1', {id:'detail-title'}), el('p', {id:'detail-subtitle', class:'subtitle'}), el('div', {class:'tabs', 'aria-label':'作品内容'}, ...Object.entries({chapters:'章节', candidates:'候选', materials:'小说资料'}).map(([key,text]) => btn(text, () => openProject(selected, key), '', 'tab-' + key))), search('file-search', '搜索当前列表', renderFiles), el('div', {id:'detail-content'}))),
    section('chat', el('div', {class:'heading-row'}, title('AI 对话'), btn(icon('clock'), openSessions, 'icon-btn', 'sessions')), el('label', {class:'project-picker'}, '当前作品', el('select', {id:'chat-project', 'aria-label':'对话作品', onchange:updateControls})), note('手机会话独立保存，桌面历史只读'), el('div', {class:'chat-project'}, el('small', {id:'model-label'}, '连接后显示电脑现有模型')), el('p', {id:'task-summary', role:'status', 'aria-live':'polite'}, '尚未启动任务'), el('div', {id:'messages'}, empty('选择作品，和电脑上的模型开始一次对话。')), el('div', {id:'questions'}),
      el('div', {class:'composer'}, el('form', {id:'chat-form', class:'compose-box', onsubmit:startTask}, el('textarea', {id:'chat-input', 'aria-label':'给 AI 的指令', placeholder:'说说你的写作想法…', maxlength:'8000'}), el('div', {class:'compose-tools'}, el('select', {id:'chat-mode', 'aria-label':'AI 模式', onchange:modeHint}, el('option', {value:'readonly'}, '只读讨论'), el('option', {value:'writing'}, '生成新候选')), el('button', {id:'send', class:'send-btn', type:'submit', 'aria-label':'发送到电脑'}, icon('send')))), el('p', {id:'mode-hint', class:'demo-note'}, '只读讨论：读取资料并讨论，不修改作品。'), el('div', {class:'task-actions'}, btn('停止任务', stopTask, 'secondary', 'stop-task'), btn('刷新状态', () => fetchTask(), '', 'refresh-task')), note('离开页面或网络断开后，电脑仍会继续任务。'), el('p', {id:'chat-error', class:'error-text', role:'alert'}))),
    section('profile', title('连接写作电脑'), el('p', {class:'subtitle'}, '使用电脑连接进程提供的配对链接或配对码。'), el('div', {class:'connection'}, icon('pc'), el('span', {id:'device-label'}, '尚未配对')), el('form', {id:'pair-form', class:'pair-form', onsubmit:submitPair}, el('label', {for:'pair-input'}, '配对链接或配对码'), el('textarea', {id:'pair-input', rows:'4', autocomplete:'off', autocapitalize:'off', spellcheck:'false', placeholder:'粘贴完整配对链接或 43 位配对码'}), el('button', {id:'pair-submit', type:'submit', class:'primary'}, '连接电脑', icon('arrow'))), el('p', {id:'pair-error', class:'error-text', role:'alert'}), btn('断开并清除本页资料', disconnect, 'secondary', 'disconnect'), note('配对码仅在本页内存中使用，刷新后需重新配对。请只使用自己电脑提供的链接。'), el('div', {class:'settings-group'}, btn([icon('moon'), el('span', {}, '界面主题'), el('small', {id:'theme-name'}, '晨雾白'), icon('next')], toggleTheme, 'settings-row')))
  ),
  el('nav', {class:'bottomnav', 'aria-label':'主导航'}, ...[['home','home','工作台'],['books','book','作品'],['chat','chat','AI 对话'],['profile','pc','连接']].map(([id,i,text]) => { const b = btn([icon(i), text], () => page(id)); b.dataset.page = id; if(id === 'home') b.setAttribute('aria-current','page'); return b; }))
);
const reader = el('dialog', {id:'reader', class:'reader', 'aria-label':'只读阅读'}, el('header', {class:'reader-bar'}, btn(icon('back'), closeReader, 'icon-btn', 'close-reader'), el('span', {id:'reader-book'}), el('div', {class:'reader-tools'}, btn('Aa', () => { fontIndex = (fontIndex + 1) % 3; document.documentElement.style.setProperty('--read', [17,19,21][fontIndex] + 'px'); }, 'icon-btn'), themeButton('reader-theme'))), el('article', {}, el('span', {class:'tag'}, '只读'), el('h1', {id:'reader-title'}), el('div', {id:'reader-meta', class:'reader-meta'}), el('div', {id:'reader-prose', class:'prose'})), el('footer', {class:'reader-bottom'}, note('只读阅读 · 候选采用与原稿修改请回到电脑操作')));
const sheet = el('dialog', {id:'sheet', 'aria-label':'会话记录'}, el('div', {class:'sheet-head'}, el('h2', {}, '会话记录'), btn(icon('close'), () => sheet.close(), 'icon-btn')), el('div', {id:'sheet-content', class:'sheet-body'}));
document.body.append(reader, sheet);
let fontIndex = 0, readerFocus, readRequest = 0;
let client = null, connection = 'closed', hello = null, generation = 0;
let projects = [], selected = null, category = 'chapters', files = [], fileRequest = 0;
let taskId = '', task = null, polling = null, pollBusy = false, sending = false, actionBusy = false, uncertain = false;
let questionKey = '';
try { taskId = sessionStorage.getItem('dc-mobile-task') || ''; } catch {}
function storeTask() { try { taskId ? sessionStorage.setItem('dc-mobile-task', taskId) : sessionStorage.removeItem('dc-mobile-task'); } catch {} }
function page(id) {
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
function disconnect() { reset(); page('profile'); }
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
  $('detail-title').textContent = project.name; $('detail-subtitle').textContent = '电脑作品 · 只读阅读'; $('file-search').value = '';
  for(const key of ['chapters','candidates','materials']) { $('tab-' + key).classList.toggle('selected', key === tab); $('tab-' + key).setAttribute('aria-pressed', String(key === tab)); }
  $('detail-content').replaceChildren(empty('正在读取列表…'));
  try { const value = await rpc('files.list', {projectId:project.id, category:tab}); if(request !== fileRequest) return; files = Array.isArray(value) ? value : []; renderFiles(); }
  catch(error) { if(request === fileRequest) $('detail-content').replaceChildren(empty(errorText(error)), btn('重新读取', () => openProject(project,tab), 'secondary')); }
}
function renderFiles() {
  const term = $('file-search').value.trim().toLocaleLowerCase();
  const list = files.filter(f => String(f.name).toLocaleLowerCase().includes(term));
  $('detail-content').replaceChildren(...(list.length ? list.map(f => row(f.name, [category === 'candidates' ? '候选 · 只读' : '只读', f.size != null ? Math.ceil(f.size / 1024) + ' KB' : '', date(f.modifiedAt)].filter(Boolean).join(' · '), () => readFile(selected, f))) : [empty(term ? '没有匹配的文件。' : {chapters:'还没有章节。',candidates:'暂无候选稿。',materials:'暂无小说资料。'}[category])]));
}
function showReader(book, name, content, meta) {
  readerFocus = document.activeElement; $('reader-book').textContent = book; $('reader-title').textContent = name;
  $('reader-meta').textContent = meta; $('reader-prose').textContent = content; if(!reader.open) reader.showModal(); reader.scrollTop = 0;
}
function closeReader() { reader.close(); readerFocus?.focus(); }
async function readFile(project, file) {
  const epoch = generation, request = ++readRequest;
  showReader(project.name, file.name, '正在读取正文…', '只读');
  try { const value = await rpc('file.read', {projectId:project.id, fileId:file.id}); if(epoch !== generation || request !== readRequest || !reader.open) return; showReader(project.name, value.name, value.content, value.truncated ? '长文仅显示部分内容 · 完整正文请回到电脑阅读' : '只读 · ' + (value.version || '')); }
  catch(error) { if(epoch === generation && request === readRequest && reader.open) $('reader-prose').textContent = errorText(error); }
}
async function openSessions() {
  const projectId = $('chat-project').value; if(!projectId) { page('profile'); return; }
  const epoch = generation; $('sheet-content').replaceChildren(empty('正在读取会话…')); sheet.showModal();
  try { const list = await rpc('sessions.list', {projectId}); if(epoch !== generation || !sheet.open) return; $('sheet-content').replaceChildren(note('手机会话独立保存，桌面历史只读'), ...(list.length ? list.map(s => row(s.title || '未命名会话', (s.source === 'desktop' ? '桌面历史 · 只读' : '手机会话 · 只读记录') + ' · ' + date(s.updatedAt), () => readSession(projectId, s))) : [empty('暂无会话记录。')])); }
  catch(error) { if(epoch === generation) $('sheet-content').replaceChildren(empty(errorText(error))); }
}
async function readSession(projectId, session) {
  const epoch = generation;
  try { const value = await rpc('session.read', {projectId, sessionId:session.id}); if(epoch !== generation) return; sheet.close(); showReader(projects.find(p => p.id === projectId)?.name || '', value.title, (value.messages || []).map(m => (m.role === 'user' ? '你' : 'DeepCompose') + '\n' + m.text).join('\n\n'), '历史会话 · 只读'); }
  catch(error) { if(epoch === generation) $('sheet-content').replaceChildren(empty(errorText(error))); }
}
function activeTask() { return !!taskId && (!task || ['running','waiting'].includes(task.state)); }
function updateControls() {
  const online = connection === 'connected'; const active = activeTask();
  $('send').disabled = !online || hello?.configured === false || !projects.length || ! $('chat-project').value || active || sending || uncertain;
  $('stop-task').disabled = !online || !taskId || !active || actionBusy;
  $('refresh-task').disabled = !online || !taskId;
  $('chat-project').disabled = active || sending;
  $('chat-mode').disabled = active || sending;
  $('pair-submit').disabled = connection === 'connecting';
}
function modeHint() { $('mode-hint').textContent = $('chat-mode').value === 'writing' ? '仅生成新候选：不能覆盖正式稿、资料或既有候选，采用请回电脑操作。' : '只读讨论：读取资料并讨论，不修改作品。'; }
async function startTask(event) {
  event.preventDefault(); if($('send').disabled) return;
  const text = $('chat-input').value.trim(); if(!text) { $('chat-input').focus(); return; }
  const projectId = $('chat-project').value, mode = $('chat-mode').value === 'writing' ? 'writing' : 'readonly';
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
