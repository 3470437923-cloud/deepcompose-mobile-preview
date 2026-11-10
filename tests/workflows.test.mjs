import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {DataStore} from '../bridge/data-store.mjs';
const bundle=await build({entryPoints:[path.resolve('bridge/workflows.ts')],bundle:true,write:false,format:'esm',platform:'node',target:'node24',alias:{'deepcompose-core':path.resolve(process.env.DEEPCOMPOSE_SOURCE||'../DeepCompose','src/core')},logLevel:'silent'});
const {createWorkflows}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
async function fixture(t,name='第十二章-候选.md'){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dc-workflow-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const booksRoot=path.join(dir,'books'),root=path.join(booksRoot,'测试书'),runtimeDir=path.join(dir,'runtime');
 await fs.mkdir(runtimeDir,{recursive:true,mode:0o700});for(const n of ['待确认','章节内容','小说资料'])await fs.mkdir(path.join(root,n),{recursive:true});
 await fs.mkdir(path.dirname(path.join(root,'待确认',name)),{recursive:true});await fs.writeFile(path.join(root,'待确认',name),'合成候选文本，绝不请求模型。');
 const store=new DataStore({booksRoot,runtimeDir});const [{id:projectId}]=await store.projects();const [file]=await store.files(projectId,'candidates');const source=await store.full(projectId,file.id);
 const starts=[];let busy=false;const engine={busy:()=>busy,start:async input=>{starts.push(input);return {taskId:'task-'+starts.length};}};
 const flow=createWorkflows({store,engine,runtimeDir});return {dir,root,runtimeDir,store,engine,starts,flow,input:{projectId,fileId:file.id,version:source.version},setBusy:value=>busy=value};
}
test('preview resolves chapter and adoption starts desktop five-step task once',async t=>{
 const f=await fixture(t),p=await f.flow.preview(f.input);assert.equal(p.targetName,'章节内容/第12章.md');assert.equal(p.existing,null);
 const input={...f.input,token:p.token,requestId:'adopt-1'};const [a,b]=await Promise.all([f.flow.adopt(input),f.flow.adopt(input)]);assert.deepEqual(a,b);assert.equal(a.operation,'adoption');assert.equal(f.starts.length,1);
 const job=f.starts[0];assert.deepEqual(job.expectedFiles,[{path:path.join(f.root,'待确认','第十二章-候选.md'),version:f.input.version},{path:path.join(f.root,'章节内容','第12章.md'),version:null}]);assert.equal(job.mode,'dev');assert.match(job.text,/登记采用版本/);assert.match(job.text,/全部成功后/);assert.ok(job.text.includes('待确认/已处理/'));assert.match(job.prompt,/版本/);assert.equal(job.text.includes('合成候选文本'),false);
 await assert.rejects(f.flow.adopt({...input,requestId:'adopt-2'}),/TOKEN_USED/);
});
test('confirmation binds missing target and source versions',async t=>{
 const f=await fixture(t),p=await f.flow.preview(f.input);await fs.writeFile(path.join(f.root,'章节内容','第12章.md'),'电脑刚创建的正文');
 await assert.rejects(f.flow.adopt({...f.input,token:p.token,requestId:'race'}),/VERSION_CONFLICT/);assert.equal(f.starts.length,0);
 const p2=await f.flow.preview(f.input);assert.ok(p2.existing);await fs.writeFile(path.join(f.root,'待确认','第十二章-候选.md'),'新版');await assert.rejects(f.flow.adopt({...f.input,token:p2.token,requestId:'source-race'}),/VERSION_CONFLICT/);
});
test('target is rechecked after the final candidate read',async t=>{
 const f=await fixture(t),p=await f.flow.preview(f.input),full=f.store.full.bind(f.store);let reads=0;
 f.store.full=async(projectId,fileId)=>{const data=await full(projectId,fileId);if(fileId===f.input.fileId&&++reads===2)await fs.writeFile(path.join(f.root,'章节内容','第12章.md'),'确认期间电脑新稿');return data;};
 await assert.rejects(f.flow.adopt({...f.input,token:p.token,requestId:'late-target'}),/VERSION_CONFLICT/);assert.equal(f.starts.length,0);
});
test('existing target mutation and deletion invalidate confirmation',async t=>{
 const f=await fixture(t);const target=path.join(f.root,'章节内容','第12章.md');await fs.writeFile(target,'旧正文');const p=await f.flow.preview(f.input);await fs.writeFile(target,'新正文');
 await assert.rejects(f.flow.adopt({...f.input,token:p.token,requestId:'changed'}),/VERSION_CONFLICT/);const p2=await f.flow.preview(f.input);await fs.unlink(target);await assert.rejects(f.flow.adopt({...f.input,token:p2.token,requestId:'deleted'}),/VERSION_CONFLICT/);
});
test('rejects processed candidates, unknown chapter, stale version and wrong token binding',async t=>{
 const processed=await fixture(t,'已处理/第1章-候选.md');await assert.rejects(processed.flow.preview(processed.input),/CANDIDATE_REQUIRED/);
 const invalid=await fixture(t,'没有章号.md');await assert.rejects(invalid.flow.preview(invalid.input),/INVALID_CHAPTER/);
 const f=await fixture(t);await assert.rejects(f.flow.preview({...f.input,version:'stale'}),/VERSION_CONFLICT/);const p=await f.flow.preview(f.input);await assert.rejects(f.flow.adopt({...f.input,fileId:'other',token:p.token,requestId:'wrong'}),/TOKEN_INVALID/);
});
test('busy and engine-start failure preserve confirmation for retry',async t=>{
 const f=await fixture(t),p=await f.flow.preview(f.input),input={...f.input,token:p.token,requestId:'retry'};f.setBusy(true);await assert.rejects(f.flow.adopt(input),/ENGINE_BUSY/);f.setBusy(false);
 const start=f.engine.start;f.engine.start=async()=>{throw Error('START_FAILED');};await assert.rejects(f.flow.adopt(input),/START_FAILED/);f.engine.start=start;assert.equal((await f.flow.adopt(input)).taskId,'task-1');
});
test('token expiry and maximum confirmation count are enforced',async t=>{
 const f=await fixture(t);const now=Date.now;let clock=now();Date.now=()=>clock;t.after(()=>Date.now=now);const p=await f.flow.preview(f.input);clock+=600001;await assert.rejects(f.flow.adopt({...f.input,token:p.token,requestId:'expired'}),/TOKEN_INVALID/);
 for(let i=0;i<64;i++)await f.flow.preview(f.input);await assert.rejects(f.flow.preview(f.input),/TOKEN_LIMIT/);
});
test('reflow rejects materials and invalid tracks; no baseline is honestly disclosed',async t=>{
 const f=await fixture(t);await assert.rejects(f.flow.reflow({...f.input,track:'invalid',requestId:'bad'}),/TRACK_INVALID/);await fs.writeFile(path.join(f.root,'小说资料','资料.md'),'设定');const [m]=await f.store.files(f.input.projectId,'materials');const material=await f.store.full(f.input.projectId,m.id);await assert.rejects(f.flow.reflow({...f.input,fileId:m.id,version:material.version,track:'facts',requestId:'material'}),/REFLOW_UNSUPPORTED/);
 const input={...f.input,track:'both',requestId:'both'};const a=await f.flow.reflow(input);assert.deepEqual(await f.flow.reflow(input),a);const task=f.starts[0];assert.deepEqual(task.expectedFiles,[{path:path.join(f.root,'待确认','第十二章-候选.md'),version:f.input.version}]);assert.ok(task.text.length<=8000);assert.match(task.text,/禁止.*候选情节/);assert.match(task.text,/风格回流/);assert.match(task.prompt,/没有本机编辑前版本/);assert.equal(task.text.includes('合成候选文本'),false);
});
test('only committed postVersion-linked intact backup supplies reflow diff',async t=>{
 const f=await fixture(t),backupDir=path.join(f.runtimeDir,'backups');await fs.mkdir(backupDir,{mode:0o700});const bytes=Buffer.from('真正的编辑前原文');const id=randomUUID();const meta={projectId:f.input.projectId,fileId:f.input.fileId,version:'old',postVersion:f.input.version,committed:true,createdAt:new Date().toISOString(),size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};await fs.writeFile(path.join(backupDir,id+'.bin'),bytes);await fs.writeFile(path.join(backupDir,id+'.json'),JSON.stringify(meta));
 await f.flow.reflow({...f.input,track:'style',requestId:'baseline'});assert.match(f.starts[0].text,/真正的编辑前原文/);assert.equal(f.starts[0].prompt.includes('没有本机编辑前版本'),false);
 await fs.writeFile(path.join(backupDir,id+'.bin'),'篡改');await f.flow.reflow({...f.input,track:'facts',requestId:'tampered'});assert.match(f.starts[1].prompt,/没有本机编辑前版本/);
});

test('requestId collisions and separate concurrent starts never duplicate engine tasks',async t=>{
 const f=await fixture(t),p=await f.flow.preview(f.input);let release;const original=f.engine.start;f.engine.start=async input=>{await new Promise(resolve=>release=resolve);return original(input);};
 const input={...f.input,token:p.token,requestId:'pending'};const pending=f.flow.adopt(input);
 while(!release)await new Promise(setImmediate);
 await assert.rejects(f.flow.adopt({...input,version:'wrong'}),/REQUEST_CONFLICT/);
 await assert.rejects(f.flow.adopt({...input,requestId:'separate'}),/ENGINE_BUSY/);
 release();assert.equal((await pending).taskId,'task-1');assert.equal(f.starts.length,1);
});
test('large real committed edits preserve both discipline tails within 8000 characters',async t=>{
 const f=await fixture(t);const old=await f.store.full(f.input.projectId,f.input.fileId);const text=('长篇编辑后的段落。'.repeat(120)+'\n').repeat(100);
 const chunks=text.match(/[\s\S]{1,16000}/g);const upload=await f.store.beginWrite(f.input.projectId,f.input.fileId,{version:old.version,totalChunks:chunks.length,bytes:Buffer.byteLength(text)});
 for(let index=0;index<chunks.length;index++)await f.store.appendWrite(f.input.projectId,{uploadId:upload.uploadId,index,content:chunks[index]});
 const saved=await f.store.commitWrite(f.input.projectId,{uploadId:upload.uploadId,version:old.version});
 await f.flow.reflow({...f.input,version:saved.version,track:'both',requestId:'real-save'});assert.equal(f.starts[0].prompt.includes('没有本机编辑前版本'),false);assert.match(f.starts[0].text,/合成候选文本/);assert.ok(f.starts[0].text.length<=8000);assert.match(f.starts[0].text,/不更新追踪表与任何事实记录/);
 await assert.rejects(f.flow.reflow({...f.input,track:'both',requestId:'stale'}),/VERSION_CONFLICT/);
});
