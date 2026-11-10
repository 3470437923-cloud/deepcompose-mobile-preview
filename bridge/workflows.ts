
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {buildReflowPrompt,buildStyleReflowPrompt} from 'deepcompose-core/ai/reflow';
import {parseChapterName,stripMd} from 'deepcompose-core/store/chapter';
import {diffLines} from 'deepcompose-core/store/oplog';
import {pairedDiff} from 'deepcompose-core/store/pairedDiff';
const TTL=600000,MAX_TEXT=2*1024*1024;
const hash=(value)=>createHash('sha256').update(value).digest('hex');
const fail=(code)=>{throw Error(code);};
const relative=(root,full)=>path.relative(root,full).split(path.sep).join('/');

function adoptionMessage(rel){
 return '【采用门】我采用 '+rel+' 作为该候选对应章节的最终稿。指定版本已经确认，不重复确认采用；只有版本歧义或需要修改用户文字时才提问。请执行采用回写：'+
 '1) 在 小说资料/00-项目状态.md 登记采用版本并把回写标为进行中；'+
 '2) 把最终稿保存为 章节内容/第N章.md（N 取该候选章号）；'+
 '3) 只按最终稿增量更新 00 声明启用的追踪表（节内替换，注明来源章节）；本章是当前细纲最后一章时把该细纲改名为（已完成）、状态行改为已完成，采用稿偏离细纲时在该细纲末尾补「实际与细纲差异」节（没偏离不补）；'+
 '4) 逐项核对后清除待办，把本章当前候选及已有旧版稿件移入 待确认/已处理/ 留档并清候选指针；'+
 '5) 全部成功后标记完成并推进当前章节；当前细纲全部完成则按 04-粗纲 建下一段细纲并更新 00 的当前细纲指针。中断先补余项，不重复累计，全部核对成功前不写新章。';
}
async function boundedFile(file,limit){
 const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>limit)fail('BACKUP_INVALID');
  const bytes=Buffer.alloc(stat.size);let offset=0;
  while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)fail('BACKUP_INVALID');offset+=bytesRead;}
  const after=await handle.stat();if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)fail('BACKUP_INVALID');return bytes;
 }finally{await handle.close();}
}
export function createWorkflows({store,engine,runtimeDir}){
 const tokens=new Map(),requests=new Map();let starting=false;
 function prune(){const now=Date.now();for(const [key,t]of tokens)if(!t.pending&&t.expires<=now)tokens.delete(key);for(const [key,r]of requests)if(!r.pending&&r.expires<=now)requests.delete(key);}
 async function source(input,candidateOnly=false){
  const {projectId,fileId,version}=input;if(typeof version!=='string'||!version)fail('VERSION_CONFLICT');
  const record=store.record(projectId,fileId),root=store.root(projectId),rel=relative(root,record.full);
  if(record.root!==root)fail('FILE_DENIED');
  if(candidateOnly&&(record.category!=='candidates'||!/^待确认\/[^/\\\x00-\x1f]+\.md$/i.test(rel)))fail('CANDIDATE_REQUIRED');
  if(!['chapters','candidates'].includes(record.category))fail('REFLOW_UNSUPPORTED');
  if(rel.split('/').some(p=>p==='..'||p==='.'||!p)||rel.includes('\\'))fail('FILE_DENIED');
  const data=await store.full(projectId,fileId);if(data.size>MAX_TEXT)fail('FILE_TOO_LARGE');if(data.version!==version)fail('VERSION_CONFLICT');return {record,root,rel,data};
 }
 async function target(projectId,root,targetName){
  const full=path.join(root,...targetName.split('/'));
  const dir=await fs.lstat(path.dirname(full)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(dir&&(!dir.isDirectory()||dir.isSymbolicLink()))fail('FILE_DENIED');
  const stat=await fs.lstat(full).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(!stat)return null;
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('FILE_DENIED');
  const files=await store.files(projectId,'chapters');
  const item=files.find(f=>{const r=store.record(projectId,f.id);return r.category==='chapters'&&r.root===root&&path.resolve(r.full)===full;});if(!item)fail('VERSION_CONFLICT');
  const data=await store.full(projectId,item.id);return {id:item.id,name:targetName,version:data.version,size:data.size};
 }
 function once(input,operation,work){
  prune();if(typeof input.requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.requestId))return Promise.reject(Error('REQUEST_INVALID'));
  const signature=JSON.stringify([operation,input.projectId,input.fileId,input.version,input.token??null,input.track??null]);
  const prior=requests.get(input.requestId);if(prior)return prior.signature===signature?prior.promise:Promise.reject(Error('REQUEST_CONFLICT'));
  if(requests.size>=128)return Promise.reject(Error('REQUEST_LIMIT'));
  const entry={signature,pending:true,expires:Date.now()+TTL,promise:null};
  // 先登记promise；同requestId重传不能同时启动两个任务。
  entry.promise=Promise.resolve().then(async()=>{
   if(starting||engine.busy())fail('ENGINE_BUSY');starting=true;
   try{return await work();}finally{starting=false;}
  }).then(result=>{entry.pending=false;entry.expires=Date.now()+TTL;return result;},error=>{requests.delete(input.requestId);throw error;});requests.set(input.requestId,entry);return entry.promise;
 }
 async function baseline(input){
  if(!runtimeDir)return null;const dir=path.join(runtimeDir,'backups');
  try{
   for(const p of [runtimeDir,dir]){const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink())return null;}
   const names=(await fs.readdir(dir)).filter(n=>/^[0-9a-f-]{36}\.json$/i.test(n));
   const ordered=await Promise.all(names.map(async name=>({name,mtime:(await fs.lstat(path.join(dir,name))).mtimeMs})));ordered.sort((a,b)=>b.mtime-a.mtime);
   const candidates=[];
   for(const {name}of ordered.slice(0,500)){
    try{const meta=JSON.parse((await boundedFile(path.join(dir,name),16384)).toString('utf8'));
     // 旧version和sha不足以证明当前稿来自本机保存；无成功关联时不虚构历史。
     if(meta.projectId===input.projectId&&meta.fileId===input.fileId&&meta.committed===true&&meta.postVersion===input.version&&Number.isFinite(Date.parse(meta.createdAt)))candidates.push({name,meta});
    }catch{}
   }
   candidates.sort((a,b)=>Date.parse(b.meta.createdAt)-Date.parse(a.meta.createdAt));
   for(const {name,meta}of candidates){try{
    const bytes=await boundedFile(path.join(dir,name.replace(/\.json$/,'.bin')),MAX_TEXT);if(bytes.length!==meta.size||hash(bytes)!==meta.sha256)continue;
    if(bytes[0]===255&&bytes[1]===254)return new TextDecoder('utf-16le').decode(bytes).replace(/^\uFEFF/,'');
    if(bytes[0]===254&&bytes[1]===255)return new TextDecoder('utf-16be').decode(bytes).replace(/^\uFEFF/,'');
    try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return new TextDecoder('gb18030',{fatal:true}).decode(bytes);}
   }catch{}}
  }catch{}return null;
 }
 return {
  async preview(input){
   const s=await source(input,true),chapter=parseChapterName(stripMd(s.data.name));if(chapter?.no==null||!Number.isSafeInteger(chapter.no))fail('INVALID_CHAPTER');
   const targetName='章节内容/第'+chapter.no+'章.md',existing=await target(input.projectId,s.root,targetName);prune();if(tokens.size>=64)fail('TOKEN_LIMIT');
   const token=randomUUID();tokens.set(token,{projectId:input.projectId,fileId:input.fileId,version:input.version,root:s.root,rel:s.rel,targetName,existing,expires:Date.now()+TTL,pending:false,used:false});
   return {token,targetName,existing,sourceName:s.rel,warnings:[...(existing?['目标正文已存在；采用任务将核对并更新该版本。']:[]),'采用会启动 AI 登记、正文保存、资料回写、归档及章节推进；任务结束后请核对实际回执。']};
  },
  adopt(input){return once(input,'adoption',async()=>{
   const token=tokens.get(input.token);if(!token||token.expires<=Date.now()||token.projectId!==input.projectId||token.fileId!==input.fileId||token.version!==input.version)fail('TOKEN_INVALID');
   if(token.used)fail('TOKEN_USED');if(token.pending)fail('ENGINE_BUSY');token.pending=true;
   try{
    const s=await source(input,true);if(s.root!==token.root||s.rel!==token.rel)fail('VERSION_CONFLICT');
    const current=await target(input.projectId,s.root,token.targetName);if(current?.id!==token.existing?.id||current?.version!==token.existing?.version)fail('VERSION_CONFLICT');
    await source(input,true);
    const finalTarget=await target(input.projectId,s.root,token.targetName);
    if(finalTarget?.id!==token.existing?.id||finalTarget?.version!==token.existing?.version)fail('VERSION_CONFLICT');
    if(engine.busy())fail('ENGINE_BUSY');
    const prompt='手机端采用确认已完成。执行前先用工具读取候选 '+JSON.stringify(s.rel)+' 并核对这是用户确认的同一版本；源版本='+JSON.stringify(input.version)+'，解码后内容SHA-256='+hash(s.data.content)+'；目标='+JSON.stringify(token.targetName)+'，确认目标版本='+JSON.stringify(current?.version??'不存在')+'。出现变化或歧义立即停止并请求重新确认，不猜测或采用其他稿。过程结论只在聊天反馈，不创建过程报告。';
    const result=await engine.start({requestId:input.requestId,projectId:input.projectId,root:s.root,text:adoptionMessage(s.rel),mode:'dev',prompt,expectedFiles:[{path:s.record.full,version:input.version},{path:path.join(s.root,...token.targetName.split('/')),version:token.existing?.version??null}]});token.used=true;token.expires=Date.now()+TTL;return {...result,operation:'adoption'};
   }finally{token.pending=false;}
  });},
  reflow(input){return once(input,'reflow',async()=>{
   if(!['facts','style','both'].includes(input.track))fail('TRACK_INVALID');const s=await source(input),before=await baseline(input);
   const fullDiff=diffLines(before??s.data.content,s.data.content),diff={...fullDiff,added:fullDiff.added.slice(0,2).map(l=>l.slice(0,200)),removed:fullDiff.removed.slice(0,2).map(l=>l.slice(0,200))};
   const chapter=parseChapterName(stripMd(s.data.name)),base={relPath:s.rel,kind:s.record.category==='candidates'?'candidate':'chapter',chapterLabel:chapter?.no==null?null:'第'+chapter.no+'章',diff,paired:undefined};
   // 小型完整文本才配对；大稿使用真实行diff摘要，不截原文后伪造段落对齐。
   if(before!==null&&before.length+s.data.content.length<=500)base.paired=pairedDiff(before,s.data.content);
   const compose=()=>[...(input.track!=='style'?[buildReflowPrompt(base)]:[]),...(input.track!=='facts'?[buildStyleReflowPrompt(base)]:[])].join('\n\n');
   let text=compose();if(text.length>8000){base.paired=undefined;base.diff={...diff,added:[],removed:[]};text=compose();}if(text.length>8000)fail('PROMPT_TOO_LARGE');
   const prompt='手机端显式回流任务；只按指定轨道执行。文件='+JSON.stringify(s.rel)+'，版本='+JSON.stringify(input.version)+'，解码后内容SHA-256='+hash(s.data.content)+'。先用工具读取最新全文；若确认版本发生变化则停止要求刷新。diff只是有界摘要，不能据摘要缺失推断全文未变。'+(before===null?'没有本机编辑前版本，仅审稿核对，不推测历史改动或风格偏好，已有追踪表不重复累计。风格轨道本次不得创建或追加学习条目；零变更摘要不代表用户没有修改。':'有经成功保存关联和SHA-256核验的本机编辑前版本；只基于实际差异审稿或学习。');
   await source(input);if(engine.busy())fail('ENGINE_BUSY');const result=await engine.start({requestId:input.requestId,projectId:input.projectId,root:s.root,text,mode:'dev',prompt,expectedFiles:[{path:s.record.full,version:input.version}]});return {...result,operation:'reflow'};
  });}
 };
}
