import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const categories={chapters:'章节内容',candidates:'待确认',materials:'小说资料'};
const MAX_READ=65536;
const opaque=value=>createHash('sha256').update(value).digest('hex').slice(0,32);
const hash=value=>createHash('sha256').update(value).digest('hex');
const inside=(root,p)=>p===root||p.startsWith(root+path.sep);
const visible=name=>name.length>0&&!name.startsWith('.')&&!name.toLowerCase().startsWith('writerd_')&&!name.includes(String.fromCharCode(0));
export async function safeRead(root,target,limit=MAX_READ){
 root=path.resolve(root);target=path.resolve(target);if(!inside(root,target)||target===root)throw Error('FILE_DENIED');
 async function validate(){let current=root;const rootStat=await fs.lstat(current);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw Error('FILE_DENIED');for(const segment of path.relative(root,target).split(path.sep)){current=path.join(current,segment);const s=await fs.lstat(current);if(s.isSymbolicLink())throw Error('FILE_DENIED');}const s=await fs.lstat(target);if(!s.isFile()||s.nlink!==1)throw Error('FILE_DENIED');const real=await fs.realpath(target);if(!inside(await fs.realpath(root),real))throw Error('FILE_DENIED');return s;}
 const before=await validate();const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const opened=await handle.stat();if(!opened.isFile()||opened.nlink!==1||opened.ino!==before.ino||opened.dev!==before.dev)throw Error('FILE_DENIED');const buffer=Buffer.alloc(Math.min(limit,opened.size));const {bytesRead}=await handle.read(buffer,0,buffer.length,0);const after=await validate();if(after.ino!==opened.ino||after.dev!==opened.dev)throw Error('FILE_DENIED');const bytes=buffer.subarray(0,bytesRead);let content;const decoder=new TextDecoder('utf-8',{fatal:true});try{content=decoder.decode(bytes,{stream:opened.size>limit});}catch{if(bytes[0]===255&&bytes[1]===254)content=new TextDecoder('utf-16le').decode(bytes);else content=new TextDecoder('gb18030').decode(bytes);}return {content:content.replace(/^﻿/,''),version:hash(bytes)+':'+opened.size+':'+opened.mtimeMs,truncated:opened.size>limit,size:opened.size};}finally{await handle.close();}
}
const MAX_TEXT=2*1024*1024;
// ponytail: one process-wide queue; split by book if simultaneous writers need throughput.
let writeQueue=Promise.resolve();
function serialize(work){const task=writeQueue.then(work);writeQueue=task.catch(()=>{});return task;}
const sameIdentity=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
function decode(bytes){if(bytes[0]===255&&bytes[1]===254)return new TextDecoder('utf-16le').decode(bytes).replace(/^\uFEFF/,'');if(bytes[0]===254&&bytes[1]===255)return new TextDecoder('utf-16be').decode(bytes).replace(/^\uFEFF/,'');try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return new TextDecoder('gb18030',{fatal:true}).decode(bytes);}}
async function directory(root,target){if(!inside(root,target))throw Error('FILE_DENIED');let current=root;for(const segment of ['',...path.relative(root,target).split(path.sep).filter(Boolean)]){if(segment)current=path.join(current,segment);const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('FILE_DENIED');}return fs.lstat(target);}
async function snapshot(root,target){await directory(root,path.dirname(target));const before=await fs.lstat(target);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw Error('FILE_DENIED');if(before.size>MAX_TEXT)throw Error('FILE_TOO_LARGE');const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||!sameIdentity(before,stat))throw Error('VERSION_CONFLICT');const bytes=Buffer.alloc(stat.size);let pos=0;while(pos<bytes.length){const {bytesRead}=await handle.read(bytes,pos,bytes.length-pos,pos);if(!bytesRead)throw Error('VERSION_CONFLICT');pos+=bytesRead;}const after=await handle.stat();await directory(root,path.dirname(target));const linked=await fs.lstat(target);if(!sameIdentity(stat,after)||!sameIdentity(stat,linked)||linked.nlink!==1||linked.isSymbolicLink())throw Error('VERSION_CONFLICT');return {bytes,stat,version:hash(bytes)+':'+stat.size+':'+stat.mtimeMs};}finally{await handle.close();}}
async function privateFile(target,bytes){const handle=await fs.open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
async function finalizeMetadata(root,target,original,committed){
 const temporary=path.join(path.dirname(target),'.metadata-'+randomUUID()+'.tmp');
 let created=false;
 try{
  await directory(root,path.dirname(target));
  const before=await snapshot(root,target);
  if(hash(before.bytes)!==hash(JSON.stringify(original)))throw Error('BACKUP_METADATA_CONFLICT');
  await privateFile(temporary,JSON.stringify(committed));created=true;
  const current=await snapshot(root,target);
  if(!sameIdentity(before.stat,current.stat)||before.version!==current.version)throw Error('BACKUP_METADATA_CONFLICT');
  await directory(root,path.dirname(target));
  await fs.rename(temporary,target);created=false;
 }finally{if(created)await fs.unlink(temporary).catch(()=>{});}
}
export class DataStore{
 constructor({booksRoot,sessionDirs=[],runtimeDir}){this.booksRoot=path.resolve(booksRoot);this.runtimeDir=runtimeDir?path.resolve(runtimeDir):null;this.sessionDirs=sessionDirs;this.projectMap=new Map();this.fileMap=new Map();this.sessionMap=new Map();this.uploads=new Map();}
 record(projectId,fileId){this.root(projectId);const r=this.fileMap.get(fileId);if(!r||r.projectId!==projectId)throw Error('FILE_NOT_FOUND');const relative=path.relative(r.root,r.full).split(path.sep);if(r.root!==this.root(projectId)||!Object.hasOwn(categories,r.category)||relative[0]!==categories[r.category]||relative.length<2||relative.some(s=>!visible(s))||path.extname(r.full).toLowerCase()!=='.md'||!inside(this.booksRoot,r.full))throw Error('FILE_DENIED');return {...r};}
 getRecord(projectId,fileId){return this.record(projectId,fileId);}
 async full(projectId,fileId){const r=this.record(projectId,fileId);const data=await snapshot(this.booksRoot,r.full);return {id:fileId,name:path.basename(r.full),category:r.category,content:decode(data.bytes),version:data.version,size:data.bytes.length};}
 async chunk(projectId,fileId,{offset=0,version}={}){if(!Number.isInteger(offset)||offset<0||offset>MAX_TEXT)throw Error('OFFSET_INVALID');const data=await this.full(projectId,fileId);if(version!==undefined&&version!==data.version)throw Error('VERSION_CONFLICT');const totalChars=data.content.length;if(offset>totalChars)throw Error('OFFSET_INVALID');let end=Math.min(offset+16000,totalChars);if(end<totalChars&&end>offset&&/[\uD800-\uDBFF]/.test(data.content[end-1]))end--;const content=data.content.slice(offset,end);return {...data,content,totalChars,truncated:end<totalChars,nextOffset:end<totalChars?end:null};}
 async readChunk(projectId,fileId,options){return this.chunk(projectId,fileId,options);}
 async privateRuntime(){if(!this.runtimeDir||inside(this.booksRoot,this.runtimeDir))throw Error('RUNTIME_REQUIRED');await directory(this.runtimeDir,this.runtimeDir);const s=await fs.lstat(this.runtimeDir);if((s.mode&0o077)!==0||(typeof process.getuid==='function'&&s.uid!==process.getuid()))throw Error('RUNTIME_DENIED');return this.runtimeDir;}
 async beginWrite(projectId,fileId,{version,totalChunks,bytes}={}){return serialize(async()=>{await this.privateRuntime();if(typeof version!=='string'||!Number.isInteger(totalChunks)||totalChunks<1||totalChunks>256||!Number.isInteger(bytes)||bytes<0||bytes>MAX_TEXT)throw Error('UPLOAD_INVALID');const record=this.record(projectId,fileId);const data=await snapshot(this.booksRoot,record.full);if(data.version!==version)throw Error('VERSION_CONFLICT');this.expireUploads();if(this.uploads.size>=4)throw Error('UPLOAD_LIMIT');const uploadId=randomUUID();this.uploads.set(uploadId,{projectId,fileId,version,totalChunks,bytes,chunks:new Map(),receivedBytes:0,expires:Date.now()+600000,identity:data.stat});return {uploadId};});}
 expireUploads(){for(const [id,u]of this.uploads)if(u.expires<=Date.now())this.uploads.delete(id);}
 upload(projectId,uploadId){this.root(projectId);this.expireUploads();const u=this.uploads.get(uploadId);if(!u||u.projectId!==projectId)throw Error('UPLOAD_NOT_FOUND');return u;}
 async appendWrite(projectId,{uploadId,index,content}={}){return serialize(async()=>{const u=this.upload(projectId,uploadId);if(!Number.isInteger(index)||index<0||index>=u.totalChunks||typeof content!=='string'||content.length>16000)throw Error('CHUNK_INVALID');if(u.chunks.has(index)){if(u.chunks.get(index)!==content)throw Error('CHUNK_CONFLICT');return {received:u.chunks.size};}const bytes=Buffer.byteLength(content);if(u.receivedBytes+bytes>u.bytes||u.receivedBytes+bytes>MAX_TEXT)throw Error('UPLOAD_SIZE');u.chunks.set(index,content);u.receivedBytes+=bytes;return {received:u.chunks.size};});}
 async commitWrite(projectId,{uploadId,version}={}){
  return serialize(async()=>{
   const u=this.upload(projectId,uploadId);
   if(version!==u.version)throw Error('VERSION_CONFLICT');
   if(u.chunks.size!==u.totalChunks)throw Error('UPLOAD_INCOMPLETE');
   const text=Array.from({length:u.totalChunks},(_,i)=>u.chunks.get(i)).join('');
   const bytes=Buffer.from(text,'utf8');
   if(bytes.length!==u.bytes||bytes.length>MAX_TEXT)throw Error('UPLOAD_SIZE');
   const r=this.record(projectId,u.fileId);
   const original=await snapshot(this.booksRoot,r.full);
   if(original.version!==version||!sameIdentity(original.stat,u.identity))throw Error('VERSION_CONFLICT');
   const runtime=await this.privateRuntime();
   const backupDir=path.join(runtime,'backups');
   await fs.mkdir(backupDir,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
   await directory(runtime,backupDir);
   if(((await fs.lstat(backupDir)).mode&0o777)!==0o700)throw Error('BACKUP_DENIED');
   const backupId=randomUUID();
   const metadataPath=path.join(backupDir,backupId+'.json');
   const metadata={projectId,fileId:u.fileId,name:path.basename(r.full),category:r.category,version,createdAt:new Date().toISOString(),size:original.bytes.length,sha256:hash(original.bytes)};
   await privateFile(path.join(backupDir,backupId+'.bin'),original.bytes);
   await privateFile(metadataPath,JSON.stringify(metadata));
   const temporary=path.join(path.dirname(r.full),'.mobile-'+randomUUID()+'.tmp');
   let created=false;
   try{
    await directory(this.booksRoot,path.dirname(r.full));
    await privateFile(temporary,bytes);created=true;
    const written=await snapshot(this.booksRoot,temporary);
    const current=await snapshot(this.booksRoot,r.full);
    if(current.version!==version||!sameIdentity(current.stat,original.stat))throw Error('VERSION_CONFLICT');
    await directory(this.booksRoot,path.dirname(r.full));
    const last=await fs.lstat(r.full);
    if(!sameIdentity(last,current.stat)||last.nlink!==1||!last.isFile()||last.isSymbolicLink())throw Error('VERSION_CONFLICT');
    // Node has no openat/renameat CAS: an uncooperative external writer can still race this final check and rename.
    await fs.rename(temporary,r.full);created=false;
    this.uploads.delete(uploadId);
    // Return the version of bytes we actually installed, even if another process edits immediately afterwards.
    const savedContent=decode(bytes);
    let end=Math.min(16000,savedContent.length);
    if(end<savedContent.length&&/[\uD800-\uDBFF]/.test(savedContent[end-1]))end--;
    const saved={id:u.fileId,name:path.basename(r.full),category:r.category,content:savedContent.slice(0,end),version:written.version,size:bytes.length,totalChars:savedContent.length,truncated:end<savedContent.length,nextOffset:end<savedContent.length?end:null};
    try{
     await finalizeMetadata(runtime,metadataPath,metadata,{...metadata,postVersion:written.version,committed:true,committedAt:new Date().toISOString()});
    }catch{
     // The manuscript is already saved. Reporting failure here could cause a destructive client retry.
     saved.warning='BACKUP_METADATA_FAILED';
    }
    return saved;
   }finally{if(created)await fs.unlink(temporary).catch(()=>{});}
  });
 }
 async create(projectId,{category,name,content=''}={}){return serialize(async()=>{await this.privateRuntime();const root=this.root(projectId);if(!Object.hasOwn(categories,category))throw Error('CATEGORY_DENIED');if(typeof name!=='string'||!visible(name)||name.length>180||/[\\/\x00-\x1f\x7f]/.test(name)||name==='..'||path.extname(name).toLowerCase()!=='.md'||typeof content!=='string'||Buffer.byteLength(content)>MAX_TEXT)throw Error('FILE_DENIED');const base=path.join(root,categories[category]);await directory(this.booksRoot,base);const full=path.join(base,name);await privateFile(full,Buffer.from(content));const id=opaque(full);this.fileMap.set(id,{root,full,projectId,category});return this.chunk(projectId,id);});}
 async projects(){const entries=await fs.readdir(this.booksRoot,{withFileTypes:true}).catch(()=>[]);const out=[];const fresh=new Map();for(const e of entries){if(out.length>=100)break;if(!e.isDirectory()||e.isSymbolicLink()||!visible(e.name))continue;const root=path.join(this.booksRoot,e.name);const s=await fs.lstat(root);const id=opaque(root);fresh.set(id,root);this.projectMap.set(id,root);const chapters=await this.files(id,'chapters');const candidates=await this.files(id,'candidates');out.push({id,name:e.name,modifiedAt:s.mtime.toISOString(),chapterCount:chapters.length,candidateCount:candidates.length});}this.projectMap=fresh;return out.sort((a,b)=>b.modifiedAt.localeCompare(a.modifiedAt));}
 root(id){if(typeof id!=='string'||!this.projectMap.has(id))throw Error('PROJECT_NOT_FOUND');return this.projectMap.get(id);}
 async files(projectId,category){const root=this.root(projectId);if(!Object.hasOwn(categories,category))throw Error('CATEGORY_DENIED');const base=path.join(root,categories[category]);const collected=[];const walk=async(dir,depth)=>{if(depth>6||collected.length>=2000)return;const s=await fs.lstat(dir).catch(()=>null);if(!s||!s.isDirectory()||s.isSymbolicLink())return;const entries=await fs.readdir(dir,{withFileTypes:true});for(const e of entries){if(collected.length>=2000)break;if(!visible(e.name)||e.isSymbolicLink())continue;const full=path.join(dir,e.name);if(e.isDirectory()){await walk(full,depth+1);continue;}if(!e.isFile()||path.extname(e.name).toLowerCase()!=='.md')continue;const stat=await fs.lstat(full);if(!stat.isFile()||stat.nlink!==1)continue;const id=opaque(full);this.fileMap.set(id,{root,full,projectId,category});collected.push({id,name:path.relative(base,full),category,size:stat.size,modifiedAt:stat.mtime.toISOString()});}};await walk(base,0);return collected.sort((a,b)=>a.name.localeCompare(b.name,'zh-Hans-CN',{numeric:true}));}
 async read(projectId,fileId){const record=this.record(projectId,fileId);const data=await safeRead(this.booksRoot,record.full);return {id:fileId,name:path.basename(record.full),category:record.category,...data};}
 async sessions(projectId){const root=this.root(projectId);const out=[];for(let source=0;source<this.sessionDirs.length;source++){const dir=this.sessionDirs[source];let index;try{index=JSON.parse((await safeRead(dir,path.join(dir,'index.json'),4*1024*1024)).content);}catch{continue;}for(const [key,s]of Object.entries(index.sessions??{})){if(!/^[a-zA-Z0-9_-]{1,90}$/.test(key)||!s||typeof s.projectPath!=='string'||path.resolve(s.projectPath)!==root)continue;const id=opaque(dir+':'+key);this.sessionMap.set(id,{projectId,root:dir,full:path.join(dir,key+'.json'),projectRoot:root});out.push({id,title:String(s.title??'未命名会话').slice(0,200),updatedAt:String(s.updatedAt??''),source:source===0?'desktop':'mobile'});}}return out.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,50);}
 async session(projectId,sessionId){this.root(projectId);const record=this.sessionMap.get(sessionId);if(!record||record.projectId!==projectId)throw Error('SESSION_NOT_FOUND');const data=await safeRead(record.root,record.full,4*1024*1024);if(data.truncated)throw Error('SESSION_TOO_LARGE');const raw=JSON.parse(data.content);if(path.resolve(raw.projectPath??'')!==record.projectRoot)throw Error('SESSION_DENIED');let remaining=100*1024;const messages=[];for(const m of (Array.isArray(raw.messages)?raw.messages:[]).slice(-60).reverse()){if(remaining<100)break;if(!m||!['user','assistant'].includes(m.role)||typeof m.text!=='string')continue;let text=m.text.slice(-16000);let size=Buffer.byteLength(JSON.stringify({role:m.role,text}));while(size>remaining&&text.length>0){text=text.slice(Math.ceil(text.length/2));size=Buffer.byteLength(JSON.stringify({role:m.role,text}));}if(!text)continue;remaining-=size;messages.push({role:m.role,text});}messages.reverse();return{id:sessionId,title:String(raw.title??'会话').slice(0,200),messages,readOnly:true};}
}
