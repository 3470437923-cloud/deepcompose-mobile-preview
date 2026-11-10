import { promises as fs, constants } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024;
const CATEGORIES = new Set(['小说资料', '章节内容', '待确认']);
const inside = (root, p) => p === root || p.startsWith(root + path.sep);
const denied = () => new Error('此路径或操作未获手机任务授权');

// 每一段都检查链接；不能仅 realpath 后检查边界，否则根内链接仍可能绕过授权。
export async function noLinks(p) {
  const absolute = path.resolve(p);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) throw denied();
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      break;
    }
  }
}

export async function privateMkdir(dir) {
  await noLinks(dir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await noLinks(dir);
  await fs.chmod(dir, 0o700);
}

export async function createEngineFs({ allowedProjects, skillsDir, runtimeDir }) {
  const projects = allowedProjects.map(p => path.resolve(p));
  const runtime = path.resolve(runtimeDir), skills = path.resolve(skillsDir);
  await noLinks(runtime);
  await privateMkdir(runtime);
  for (const root of [...projects, skills]) await noLinks(root);
  let task = null;
  const owned = new Map();
  let writes = Promise.resolve();
  const serialize = (fn) => {
    const next = writes.then(fn);
    writes = next.catch(() => {});
    return next;
  };
  function locate(raw) {
    if (typeof raw !== 'string' || !path.isAbsolute(raw) || raw.includes('\0') || raw.split(/[\\/]/).includes('..')) throw denied();
    const p = path.resolve(raw);
    if (inside(runtime, p)) return { p, base: runtime, runtime: true };
    const base = projects.find(r => inside(r, p)) ?? (inside(skills, p) ? skills : null);
    if (!base) throw denied();
    const parts = path.relative(base, p).split(path.sep).filter(Boolean);
    if (parts.some(n => n.startsWith('.') || n.startsWith('writerd_') || n === 'recycle_manifest.json')) throw denied();
    if (base !== skills && parts.length && !CATEGORIES.has(parts[0])) throw denied();
    return { p, base, runtime: false };
  }
  async function inspect(raw) {
    const loc = locate(raw);
    await noLinks(loc.p);
    let st = null;
    try { st = await fs.lstat(loc.p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (st && !st.isDirectory() && (!st.isFile() || st.nlink !== 1 || (!loc.runtime && path.extname(loc.p).toLowerCase() !== '.md'))) throw denied();
    // 不存在的普通文件也必须符合扩展名规则，但结构目录可通过存在检查返回 false。
    if (!st && !loc.runtime && path.extname(loc.p) && path.extname(loc.p).toLowerCase() !== '.md') throw denied();
    return { ...loc, st };
  }
  async function readText(raw) {
    const { p, st } = await inspect(raw);
    if (!st?.isFile() || st.size > MAX_BYTES) throw denied();
    const h = await fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const actual = await h.stat();
      if (!actual.isFile() || actual.nlink !== 1 || actual.size > MAX_BYTES || actual.ino !== st.ino || actual.dev !== st.dev) throw denied();
      const b = await h.readFile();
      await noLinks(p);
      const after = await fs.lstat(p);
      if (b.length > MAX_BYTES || !after.isFile() || after.nlink !== 1 || after.dev !== actual.dev || after.ino !== actual.ino) throw denied();
      if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
      if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
      try { return new TextDecoder('utf-8', { fatal:true }).decode(b); }
      catch { return new TextDecoder('gbk').decode(b); }
    } finally { await h.close(); }
  }
  async function write(raw, text, append) {
    const loc = await inspect(raw);
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw denied();
    if (loc.runtime) {
      const relative = path.relative(runtime, path.dirname(loc.p)).split(path.sep).filter(Boolean);
      let dir = runtime;
      for (const segment of relative) { dir = path.join(dir, segment); await privateMkdir(dir); }
      const h = await fs.open(loc.p, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (append ? constants.O_APPEND : 0), 0o600);
      try {
        const st = await h.stat();
        if (!st.isFile() || st.nlink !== 1) throw denied();
        await h.chmod(0o600);
        if (!append) await h.truncate(0);
        await h.writeFile(text,'utf8');
        await h.sync();
      } finally { await h.close(); }
      return;
    }
    if (!task || task.mode !== 'writing' || loc.base !== task.root) throw denied();
    const rel = path.relative(task.root, loc.p).split(path.sep);
    if (rel.length !== 2 || rel[0] !== '待确认' || !rel[1].endsWith('.md')) throw denied();
    const previous = owned.get(loc.p);
    if (!previous) {
      // O_EXCL 封住 stat 到 write 之间另一个写者抢先创建的窗口。
      await noLinks(path.dirname(loc.p));
      const h = await fs.open(loc.p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await h.writeFile(text,'utf8');
        const st = await h.stat();
        owned.set(loc.p,{ dev:st.dev, ino:st.ino, content:text });
      } finally { await h.close(); }
      return;
    }
    const content = append ? previous.content + text : text;
    if (!content.startsWith(previous.content) || Buffer.byteLength(content) > MAX_BYTES) throw denied();
    const h = await fs.open(loc.p, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const st = await h.stat();
      if (st.dev !== previous.dev || st.ino !== previous.ino || st.nlink !== 1 || (await h.readFile('utf8')) !== previous.content) throw denied();
      const extra = Buffer.from(content.slice(previous.content.length));
      if (extra.length) await h.write(extra,0,extra.length,st.size);
      previous.content = content;
    } finally { await h.close(); }
  }
  return {
    beginTask({root,mode}) { if (task || !projects.includes(path.resolve(root))) throw denied(); task={root:path.resolve(root),mode}; owned.clear(); },
    endTask() { task=null; owned.clear(); },
    readText,
    writeText: (p,t) => serialize(() => write(p,t,false)),
    appendText: (p,t) => serialize(() => write(p,t,true)),
    async list(raw) {
      const {p,st}=await inspect(raw);
      if (!st) return [];
      if (!st.isDirectory()) throw denied();
      const out=[];
      for(const name of await fs.readdir(p)) {
        try {
          const entry=await inspect(path.join(p,name));
          if (!entry.st) continue;
          out.push({name,rel:name,path:entry.p,isDir:entry.st.isDirectory(),size:entry.st.isDirectory()?0:entry.st.size,mtimeMs:entry.st.mtimeMs,isLink:false});
        } catch { /* 未授权条目不暴露文件名或元数据。 */ }
      }
      return out.sort((a,b)=>Number(b.isDir)-Number(a.isDir)||a.name.localeCompare(b.name));
    },
    async exists(p) { return !!(await inspect(p)).st; },
    async stat(p) { const {st}=await inspect(p);return st ? {isDir:st.isDirectory(),size:st.isDirectory()?0:st.size,mtimeMs:st.mtimeMs,isLink:false}:null; },
    async mkdir(raw) {
      const loc=await inspect(raw);
      if (loc.runtime) { await privateMkdir(loc.p); return; }
      if (task?.mode==='writing' && loc.p===path.join(task.root,'待确认')) { await fs.mkdir(loc.p,{recursive:true,mode:0o700});return; }
      throw denied();
    },
    async remove() { throw denied(); },
    async removeChild() { throw denied(); },
    async rename() { throw denied(); },
    async copy() { throw denied(); },
  };
}

export function createFetchTransport({ fetchImpl = globalThis.fetch } = {}) {
  let active = null;
  return {
    abortActive() { active?.abort(); },
    async stream(req, handlers) {
      const abort = new AbortController();
      active = abort;
      let reader;
      try {
        const response = await fetchImpl(req.url,{method:'POST',headers:req.headers,body:JSON.stringify(req.body),signal:abort.signal,redirect:'error'});
        if (!response.ok) {
          // 上游错误体可能回显凭据；只保留分类所需状态码。
          handlers.onLine('__HTTP_ERROR__'+response.status+'|请求失败');
          await response.body?.cancel();
          return;
        }
        if (!response.body) throw new Error('empty response');
        reader=response.body.getReader();
        const decoder=new TextDecoder();
        let buffer='';
        while(true) {
          const {done,value}=await reader.read();
          buffer+=done?decoder.decode():decoder.decode(value,{stream:true});
          if(buffer.length>MAX_BYTES) throw new Error('oversized SSE line');
          let at;
          while((at=buffer.indexOf('\n'))>=0) { handlers.onLine(buffer.slice(0,at).replace(/\r$/,''));buffer=buffer.slice(at+1); }
          if(done) {if(buffer)handlers.onLine(buffer.replace(/\r$/,''));break;}
        }
      } catch {
        handlers.onError(abort.signal.aborted?'请求已中止':'模型连接失败或流中断');
      } finally {
        if(reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
        if(active===abort)active=null;
      }
    },
  };
}
