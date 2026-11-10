import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

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
    if (task?.mode === 'dev' && base !== skills && base !== task.root) throw denied();
    const parts = path.relative(base, p).split(path.sep).filter(Boolean);
    const support = task?.mode === 'dev' && base === task.root && (parts.join('/') === '.openwrite_manifest.json' || parts.join('/') === 'writerd_oplog/log.jsonl');
    if (support || (task?.mode === 'dev' && base === task.root && parts.join('/') === 'writerd_oplog')) return { p, base, runtime:false, support: support ? 'file' : 'directory' };
    if (parts.some(n => n.startsWith('.') || n.startsWith('writerd_') || n === 'recycle_manifest.json')) throw denied();
    if (base !== skills && parts.length && !CATEGORIES.has(parts[0])) throw denied();
    return { p, base, runtime: false };
  }
  async function inspectRaw(raw) {
    const loc = locate(raw);
    await noLinks(loc.p);
    let st = null;
    try { st = await fs.lstat(loc.p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (st && loc.support && (loc.support === 'directory' ? !st.isDirectory() : !st.isFile())) throw denied();
    if (st && !st.isDirectory() && (!st.isFile() || st.nlink !== 1 || (!loc.runtime && !loc.support && path.extname(loc.p).toLowerCase() !== '.md'))) throw denied();
    // 不存在的普通文件也必须符合扩展名规则，但结构目录可通过存在检查返回 false。
    if (!st && !loc.runtime && !loc.support && path.extname(loc.p) && path.extname(loc.p).toLowerCase() !== '.md') throw denied();
    return { ...loc, st };
  }
  async function inspect(raw) {
    const loc = await inspectRaw(raw);
    await assertExpected(loc);
    return loc;
  }
  const versionOf = (bytes,st) => createHash('sha256').update(bytes).digest('hex')+':'+st.size+':'+st.mtimeMs;
  async function assertExpected(loc) {
    const run=task;
    if (!run?.expected.has(loc.p)) return;
    const expected=run.expected.get(loc.p);
    if (expected === null) { if(loc.st)throw new Error('VERSION_CONFLICT'); return; }
    if (!loc.st?.isFile()) throw new Error('VERSION_CONFLICT');
    const bytes=await readBytes(loc.p,false),after=await inspectRaw(loc.p);
    if (task!==run || !sameFile(loc.st,after.st) || versionOf(bytes,after.st)!==expected) throw new Error('VERSION_CONFLICT');
  }
  function advanceExpected(p,bytes,st,run=task) {
    if (task===run && run?.expected.has(p)) run.expected.set(p,st ? versionOf(bytes,st) : null);
  }
  async function readBytes(raw,guard=true) {
    const { p, st } = await (guard ? inspect(raw) : inspectRaw(raw));
    if (!st?.isFile() || st.size > MAX_BYTES) throw denied();
    const h = await fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const actual = await h.stat();
      if (!actual.isFile() || actual.nlink !== 1 || actual.size > MAX_BYTES || !sameFile(st,actual)) throw denied();
      const b = await h.readFile();
      await noLinks(p);
      const after = await fs.lstat(p);
      if (b.length > MAX_BYTES || b.length !== actual.size || !sameFile(actual,await h.stat()) || !sameFile(actual,after)) throw denied();
      return b;
    } finally { await h.close(); }
  }
  async function readText(raw) {
      const b = await readBytes(raw);
      if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
      if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
      try { return new TextDecoder('utf-8', { fatal:true }).decode(b); }
      catch { return new TextDecoder('gbk').decode(b); }
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
    if (task?.mode === 'dev' && loc.base === task.root) { await devWrite(loc,text,append); return; }
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
        advanceExpected(loc.p,Buffer.from(text),st);
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
      advanceExpected(loc.p,Buffer.from(content),await h.stat());
    } finally { await h.close(); }
  }
  const sameFile = (a,b) => a && b && a.isFile() && b.isFile() && a.nlink === 1 && b.nlink === 1 && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  function requireDev(loc,run) {
    if (!run || task !== run || run.mode !== 'dev' || loc.runtime || loc.base !== run.root) throw denied();
  }
  async function projectMkdir(p) {
    const loc=await inspect(p),run=task;
    requireDev(loc,run);
    if (loc.support === 'file' || (loc.st && !loc.st.isDirectory())) throw denied();
    await fs.mkdir(p,{recursive:true,mode:0o700});
    await noLinks(p);
    requireDev(loc,run);
  }
  async function checkUnchanged(loc,bytes,run) {
    requireDev(loc,run);
    const current=await inspect(loc.p);
    if (!sameFile(loc.st,current.st) || !(await readBytes(loc.p)).equals(bytes)) throw denied();
    const after=await inspect(loc.p);
    if (!sameFile(loc.st,after.st)) throw denied();
    requireDev(loc,run);
  }
  async function devWrite(loc,text,append) {
    const run=task;
    requireDev(loc,run);
    if (loc.support === 'directory' || loc.st?.isDirectory() || (!loc.support && path.extname(loc.p).toLowerCase() !== '.md')) throw denied();
    const previous=loc.st ? await readBytes(loc.p) : null;
    // Backup the original encoding and bytes before any replacement.
    const content=append && previous ? Buffer.concat([previous,Buffer.from(text)]) : Buffer.from(text);
    if (content.length > MAX_BYTES) throw denied();
    await projectMkdir(path.dirname(loc.p));
    if (!previous) {
      requireDev(loc,run);
      const h=await fs.open(loc.p,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try { await h.writeFile(content);await h.sync();advanceExpected(loc.p,content,await h.stat(),run); } finally { await h.close(); }
      return;
    }
    const backupDir=path.join(runtime,'backups');
    await privateMkdir(backupDir);
    const backup=await fs.open(path.join(backupDir,randomUUID()+'.bin'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try { await backup.writeFile(previous);await backup.sync(); } finally { await backup.close(); }
    const temp=path.join(path.dirname(loc.p),'.mobile-'+randomUUID()+'.tmp');
    const h=await fs.open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try {
      await h.writeFile(content);await h.sync();const installed=await h.stat();await h.close();
      await checkUnchanged(loc,previous,run);
      await noLinks(temp);
      await fs.rename(temp,loc.p);
      advanceExpected(loc.p,content,installed,run);
    } finally { await h.close().catch(()=>{});await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;}); }
  }
  async function transfer(from,to,move) {
    const source=await inspect(from),target=await inspect(to),run=task;
    requireDev(source,run);requireDev(target,run);
    if (source.support || target.support || !source.st?.isFile() || target.st || path.extname(source.p).toLowerCase()!=='.md' || path.extname(target.p).toLowerCase()!=='.md') throw denied();
    const bytes=await readBytes(source.p);
    await projectMkdir(path.dirname(target.p));
    await checkUnchanged(source,bytes,run);
    if (move) {
      // link is an atomic no-replace destination claim; Node rename overwrites.
      await fs.link(source.p,target.p);
      try {
        await noLinks(source.p);await noLinks(target.p);
        const a=await fs.lstat(source.p),b=await fs.lstat(target.p);
        requireDev(source,run);
        if (!a.isFile() || !b.isFile() || a.nlink!==2 || b.nlink!==2 || a.ino!==source.st.ino || a.dev!==source.st.dev || b.ino!==a.ino || b.dev!==a.dev) throw denied();
        await fs.unlink(source.p);
        advanceExpected(source.p,null,null,run);
        advanceExpected(target.p,bytes,source.st,run);
      } catch(e) { await fs.unlink(target.p);throw e; }
    } else {
      const h=await fs.open(target.p,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try { await h.writeFile(bytes);await h.sync();advanceExpected(target.p,bytes,await h.stat(),run); } finally { await h.close(); }
    }
  }
  return {
    beginTask({root,mode,expectedFiles=[]}) {
      if (task || !['readonly','writing','dev'].includes(mode) || !projects.includes(path.resolve(root)) || !Array.isArray(expectedFiles) || expectedFiles.length>3) throw denied();
      const resolved=path.resolve(root),expected=new Map();
      for(const entry of expectedFiles) {
        if(!entry || typeof entry.path!=='string')throw denied();
        const loc=locate(entry.path),parts=path.relative(resolved,loc.p).split(path.sep);
        if(loc.runtime || loc.base!==resolved || parts.length<2 || !CATEGORIES.has(parts[0]) || parts.some(n=>n.startsWith('.')||n.startsWith('writerd_')||n==='recycle_manifest.json') || path.extname(loc.p).toLowerCase()!=='.md' || expected.has(loc.p) || (entry.version!==null && (typeof entry.version!=='string' || !/^[a-f0-9]{64}:[0-9]+:[0-9]+(?:[.][0-9]+)?$/.test(entry.version))))throw denied();
        expected.set(loc.p,entry.version);
      }
      task={root:resolved,mode,expected};owned.clear();
    },
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
    mkdir: (raw) => serialize(async () => {
      const loc=await inspect(raw);
      if (loc.runtime) { await privateMkdir(loc.p); return; }
      if (task?.mode==='dev' && loc.base===task.root && loc.p!==task.root) { await projectMkdir(loc.p);return; }
      if (task?.mode==='writing' && loc.p===path.join(task.root,'待确认')) { await fs.mkdir(loc.p,{recursive:true,mode:0o700});return; }
      throw denied();
    }),
    async remove() { throw denied(); },
    async removeChild() { throw denied(); },
    rename: (from,to) => serialize(() => transfer(from,to,true)),
    copy: (from,to) => serialize(() => transfer(from,to,false)),
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
