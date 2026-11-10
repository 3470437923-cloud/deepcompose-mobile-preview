import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createEngineFs, createFetchTransport } from '../bridge/engine-fs.mjs';
import { build } from 'esbuild';

let engineModule;
async function loadEngine() {
  if(!engineModule) {
    const bundled=await build({entryPoints:[path.resolve('bridge/engine.ts')],bundle:true,write:false,format:'esm',platform:'node',target:'node24',alias:{'deepcompose-core':path.resolve('../DeepCompose/src/core')},logLevel:'silent'});
    engineModule=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  }
  return engineModule;
}
async function engineFixture(t) {
  const f=await fixture(t);
  const prefsPath=path.join(f.dir,'prefs.json');
  await fs.writeFile(prefsPath,JSON.stringify({'flutter.api_key':'unit-test-credential','flutter.model':'fixture-model','flutter.llm_base_url':'https://example.test','flutter.auto_clear_context':false}));
  const options={prefsPath,booksRoot:f.dir,skillsDir:f.skillsDir,runtimeDir:f.runtimeDir,allowedProjects:[f.root]};
  const {createEngine}=await loadEngine();
  return {...f,options,createEngine,engine:await createEngine(options)};
}
function sseResponse(deltas) {
  return new Response(deltas.map(delta=>'data: '+JSON.stringify({choices:[{delta,finish_reason:null}]})+'\n\n').join('')+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
}
async function until(engine,id,predicate) {
  for(let i=0;i<200;i++) {const task=await engine.get(id);if(predicate(task))return task;await new Promise(setImmediate);}
  assert.fail('task state did not converge');
}

test('engine persists intent before fetch, completes through real controller and deduplicates after restart',async t=>{
  const {engine,root,runtimeDir,options,createEngine}=await engineFixture(t);
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let calls=0;
  globalThis.fetch=async()=>{
    calls++;
    const files=await fs.readdir(path.join(runtimeDir,'tasks'));
    assert.equal(files.filter(n=>n.endsWith('.json')).length,1);
    return sseResponse([{content:'connection verified'}]);
  };
  assert.deepEqual(engine.info(),{model:'fixture-model',configured:true});
  const input={requestId:'request-1',projectId:'project-1',root,text:'synthetic test'};
  const {taskId}=await engine.start(input);
  const done=await until(engine,taskId,s=>s.state==='completed'||s.state==='failed');
  assert.equal(done.state,'completed');assert.equal(done.text,'connection verified');
  const durable=JSON.parse(await fs.readFile(path.join(runtimeDir,'tasks',taskId+'.json'),'utf8'));
  assert.equal(durable.state,'completed');assert.equal(durable.requestId,input.requestId);
  assert.deepEqual(done.messages,[{role:'user',text:'synthetic test'},{role:'assistant',text:'connection verified'}]);
  assert.equal(JSON.stringify(done).includes('unit-test-credential'),false);
  assert.deepEqual(await engine.start(input),{taskId});
  const restarted=await createEngine(options);
  assert.deepEqual(await restarted.start(input),{taskId});
  assert.equal(calls,1);
  assert.equal((await fs.stat(path.join(runtimeDir,'tasks',taskId+'.json'))).mode&0o777,0o600);
});

test('engine enforces single active task, input limit, and immediate stop',async t=>{
  const {engine,root}=await engineFixture(t);
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let entered;const ready=new Promise(r=>entered=r);
  globalThis.fetch=(_url,{signal})=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});entered();});
  await assert.rejects(engine.start({requestId:'too-long',projectId:'p',root,text:'a'.repeat(8001)}));
  const {taskId}=await engine.start({requestId:'running',projectId:'p',root,text:'synthetic'});
  await ready;
  await assert.rejects(engine.start({requestId:'second',projectId:'p',root,text:'synthetic'}));
  assert.equal((await engine.stop(taskId)).state,'stopped');
  await until(engine,taskId,s=>s.state==='stopped');
});

test('engine marks interrupted persisted tasks failed without replay',async t=>{
  const {options,runtimeDir,createEngine}=await engineFixture(t);
  const id='11111111-1111-4111-8111-111111111111';
  await fs.writeFile(path.join(runtimeDir,'tasks',id+'.json'),JSON.stringify({id,requestId:'interrupted',projectId:'p',state:'waiting',text:'',messages:[],toolStatus:'',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),question:{id:'stale',items:[]}}));
  const engine=await createEngine(options);
  const saved=await engine.get(id);
  assert.equal(saved.state,'failed');assert.equal(saved.question,undefined);
  assert.deepEqual(await engine.start({requestId:'interrupted'}),{taskId:id});
});



test('duplicate start waits for the first durable intent before acknowledgement',async t=>{
  const {engine,root,runtimeDir}=await engineFixture(t);
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>sseResponse([{content:'ok'}]);
  const input={requestId:'concurrent',projectId:'p',root,text:'synthetic'};
  const first=engine.start(input);
  const duplicate=await engine.start(input);
  const stored=JSON.parse(await fs.readFile(path.join(runtimeDir,'tasks',duplicate.taskId+'.json'),'utf8'));
  assert.equal(stored.requestId,'concurrent');
  assert.deepEqual(await first,duplicate);
  await until(engine,duplicate.taskId,s=>s.state==='completed');
});

test('question pauses controller, validates current options, and resumes without exposing tools',async t=>{
  const {engine,root}=await engineFixture(t);
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let calls=0;
  globalThis.fetch=async()=>++calls===1?sseResponse([{tool_calls:[{index:0,id:'q1',type:'function',function:{name:'question',arguments:JSON.stringify({questions:[{question:'Continue?',options:[{label:'Yes'},{label:'No'}]}]})}}]}]):sseResponse([{content:'answered'}]);
  const {taskId}=await engine.start({requestId:'question',projectId:'p',root,text:'synthetic'});
  const waiting=await until(engine,taskId,s=>s.state==='waiting'||s.state==='failed');
  assert.equal(waiting.state,'waiting');
  await assert.rejects(engine.answer({taskId,questionId:'stale',answers:[['Yes']]}));
  await assert.rejects(engine.answer({taskId,questionId:waiting.question.id,answers:[['unlisted']]}));
  await engine.answer({taskId,questionId:waiting.question.id,answers:[['Yes']]});
  const done=await until(engine,taskId,s=>s.state==='completed'||s.state==='failed');
  assert.equal(done.state,'completed');assert.equal(done.text,'answered');
  assert.equal(done.question,undefined);
  assert.ok(done.messages.every(m=>Object.keys(m).sort().join(',')==='role,text'));
});

test('writing through real controller preserves existing manuscripts and stores snapshots privately',async t=>{
  const {engine,root,runtimeDir}=await engineFixture(t);
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let calls=0;
  const tool=(index,file,content)=>({index,id:'write'+index,type:'function',function:{name:'file_write',arguments:JSON.stringify({operation:'append',path:file,content})}});
  globalThis.fetch=async()=>++calls===1?sseResponse([{tool_calls:[tool(0,'待确认/new.md','new candidate'),tool(1,'待确认/existing.md','forbidden'),tool(2,'章节内容/第1章.md','forbidden')]}]):sseResponse([{content:'finished'}]);
  const {taskId}=await engine.start({requestId:'writing-tools',projectId:'p',root,text:'synthetic',mode:'writing'});
  const done=await until(engine,taskId,s=>s.state==='completed'||s.state==='failed');
  assert.equal(done.state,'completed');
  assert.equal(await fs.readFile(path.join(root,'待确认/new.md'),'utf8'),'new candidate');
  assert.equal(await fs.readFile(path.join(root,'待确认/existing.md'),'utf8'),'original');
  assert.equal(await fs.readFile(path.join(root,'章节内容/第1章.md'),'utf8'),'fixture');
  assert.ok((await fs.readdir(path.join(runtimeDir,'snapshots'))).some(n=>n.endsWith('.json')));
});

test('task text and message budgets keep Chinese snapshots within encrypted message limit',async t=>{
  const {engine,root}=await engineFixture(t);
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>sseResponse([{content:'汉'.repeat(40000)}]);
  const {taskId}=await engine.start({requestId:'bounded',projectId:'p',root,text:'合成测试'});
  const done=await until(engine,taskId,s=>s.state==='completed'||s.state==='failed');
  assert.equal(done.state,'completed');assert.equal(done.text.length,24000);
  assert.ok(done.messages.reduce((n,m)=>n+m.text.length,0)<=16000);
  assert.ok(Buffer.byteLength(JSON.stringify(done))<192*1024);
});

test('stopping a waiting question resolves the agent without another model request',async t=>{
  const {engine,root}=await engineFixture(t);
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let calls=0;
  globalThis.fetch=async()=>{calls++;return sseResponse([{tool_calls:[{index:0,id:'question-stop',type:'function',function:{name:'question',arguments:JSON.stringify({questions:[{question:'Continue?',options:[{label:'Yes'}]}]})}}]}]);};
  const {taskId}=await engine.start({requestId:'stop-question',projectId:'p',root,text:'synthetic'});
  const waiting=await until(engine,taskId,s=>s.state==='waiting'||s.state==='failed');
  assert.equal(waiting.state,'waiting');
  const stopped=await engine.stop(taskId);
  assert.equal(stopped.state,'stopped');assert.equal(stopped.question,undefined);assert.equal(calls,1);
});

test('upstream credential echoes cannot enter remote task snapshots',async t=>{
  const {engine,root}=await engineFixture(t);
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>sseResponse([{content:'echo: unit-test-credential'}]);
  const {taskId}=await engine.start({requestId:'redaction',projectId:'p',root,text:'synthetic'});
  const done=await until(engine,taskId,s=>s.state==='completed'||s.state==='failed');
  assert.equal(done.state,'completed');
  assert.equal(JSON.stringify(done).includes('unit-test-credential'),false);
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dc-engine-'));
  t.after(() => fs.rm(dir, {recursive:true,force:true}));
  const root = path.join(dir,'book'), runtimeDir = path.join(dir,'runtime'), skillsDir=path.join(dir,'skills');
  for(const p of [root,runtimeDir,skillsDir,...['小说资料','章节内容','待确认'].map(n=>path.join(root,n))]) await fs.mkdir(p,{recursive:true});
  await fs.writeFile(path.join(root,'章节内容','第1章.md'),'fixture');
  await fs.writeFile(path.join(root,'待确认','existing.md'),'original');
  const bridge = await createEngineFs({allowedProjects:[root], skillsDir,runtimeDir});
  return {dir,root,runtimeDir,skillsDir,bridge};
}

test('reads only authorized ordinary markdown and excludes hidden entries',async t=>{
  const {root,dir,bridge}=await fixture(t);
  await fs.writeFile(path.join(root,'章节内容','.secret.md'),'hidden');
  await fs.writeFile(path.join(root,'章节内容','config.json'),'hidden');
  assert.equal(await bridge.readText(path.join(root,'章节内容','第1章.md')),'fixture');
  assert.deepEqual((await bridge.list(path.join(root,'章节内容'))).map(e=>e.name),['第1章.md']);
  await assert.rejects(bridge.readText(path.join(root,'章节内容','.secret.md')));
  await assert.rejects(bridge.readText(path.join(dir,'outside.md')));
  await assert.rejects(bridge.readText(path.join(root,'章节内容','..','config.json')));
});

test('refuses symlinks at leaf and intermediate paths',async t=>{
  const {root,dir,bridge}=await fixture(t);
  await fs.writeFile(path.join(dir,'outside.md'),'outside');
  await fs.symlink(path.join(dir,'outside.md'),path.join(root,'章节内容','linked.md'));
  await fs.symlink(dir,path.join(root,'小说资料','linked'));
  await assert.rejects(bridge.readText(path.join(root,'章节内容','linked.md')));
  await assert.rejects(bridge.readText(path.join(root,'小说资料','linked','outside.md')));
});

test('readonly refuses writes and mutating file operations',async t=>{
  const {root,bridge}=await fixture(t);
  for(const action of [()=>bridge.writeText(path.join(root,'待确认','new.md'),'x'),()=>bridge.appendText(path.join(root,'章节内容','第1章.md'),'x'),()=>bridge.remove(root,true),()=>bridge.rename(root,root+'2'),()=>bridge.copy(root,root+'2')]) await assert.rejects(action());
});

test('writing only atomically creates new flat candidates and appends its own content',async t=>{
  const {root,bridge}=await fixture(t);
  bridge.beginTask({root,mode:'writing'});
  const file=path.join(root,'待确认','new.md');
  await bridge.writeText(file,'first');
  await bridge.appendText(file,' second');
  await bridge.writeText(file,'first second third');
  assert.equal(await fs.readFile(file,'utf8'),'first second third');
  await assert.rejects(bridge.writeText(file,'replacement'));
  await assert.rejects(bridge.writeText(path.join(root,'待确认','existing.md'),'replacement'));
  await assert.rejects(bridge.writeText(path.join(root,'章节内容','new.md'),'x'));
  await assert.rejects(bridge.writeText(path.join(root,'待确认','nested','new.md'),'x'));
  bridge.endTask();
  bridge.beginTask({root,mode:'writing'});
  await assert.rejects(bridge.appendText(file,'next task'));
});

test('refuses candidate created externally after initial existence checks',async t=>{
  const {root,bridge}=await fixture(t);
  bridge.beginTask({root,mode:'writing'});
  const file=path.join(root,'待确认','race.md');
  assert.equal(await bridge.exists(file),false);
  await fs.writeFile(file,'other writer');
  await assert.rejects(bridge.writeText(file,'overwrite'));
  assert.equal(await fs.readFile(file,'utf8'),'other writer');
});

test('runtime writes have private permissions and bounded reads',async t=>{
  const {runtimeDir,root,bridge}=await fixture(t);
  const file=path.join(runtimeDir,'sessions','session.json');
  await bridge.writeText(file,'{}');
  assert.equal((await fs.stat(file)).mode&0o777,0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode&0o777,0o700);
  await fs.writeFile(path.join(root,'章节内容','large.md'),'x'.repeat(1024*1024+1));
  await assert.rejects(bridge.readText(path.join(root,'章节内容','large.md')));
});

test('dev controller edits material, adopts candidate by move, and records runtime snapshots',async t=>{
  const {engine,root,runtimeDir}=await engineFixture(t);
  const material=path.join(root,'小说资料','notes.md');await fs.writeFile(material,'old setting');
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let calls=0;
  const tool=(index,name,args)=>({index,id:'dev'+index,type:'function',function:{name,arguments:JSON.stringify(args)}});
  globalThis.fetch=async()=>++calls===1?sseResponse([{tool_calls:[
    tool(0,'file_write',{operation:'replace',path:'小说资料/notes.md',old_text:'old setting',new_text:'updated setting'}),
    tool(1,'file_manage',{operation:'rename',path:'待确认/existing.md',new_path:'待确认/已处理/existing.md'}),
    tool(2,'file_write',{operation:'replace',path:'章节内容/第1章.md',old_text:'fixture',new_text:'adopted prose'})
  ]}]):sseResponse([{content:'finished'}]);
  const {taskId}=await engine.start({requestId:'dev-tools',projectId:'p',root,text:'synthetic authorized adoption',mode:'dev'});
  const done=await until(engine,taskId,s=>s.state==='completed'||s.state==='failed');
  assert.equal(done.state,'completed');
  assert.equal(await fs.readFile(material,'utf8'),'updated setting');
  assert.equal(await fs.readFile(path.join(root,'章节内容/第1章.md'),'utf8'),'adopted prose');
  assert.equal(await fs.readFile(path.join(root,'待确认/已处理/existing.md'),'utf8'),'original');
  await assert.rejects(fs.stat(path.join(root,'待确认/existing.md')));
  assert.ok((await fs.readdir(path.join(runtimeDir,'snapshots'))).some(n=>n.endsWith('.json')));
  const backupBytes=await Promise.all((await fs.readdir(path.join(runtimeDir,'backups'))).map(n=>fs.readFile(path.join(runtimeDir,'backups',n),'utf8')));
  assert.ok(backupBytes.includes('old setting'));assert.ok(backupBytes.includes('fixture'));
});

test('dev overwrite refuses external changes during backup and preserves the newer bytes',async t=>{
  const {root,runtimeDir,bridge}=await fixture(t);
  bridge.beginTask({root,mode:'dev'});
  const file=path.join(root,'待确认','existing.md');
  const open=fs.open;
  t.mock.method(fs,'open',async function(p,...args){
    if(typeof p==='string'&&p.startsWith(path.join(runtimeDir,'backups')+path.sep))await fs.writeFile(file,'external update');
    return open.call(fs,p,...args);
  });
  await assert.rejects(bridge.writeText(file,'stale replacement'));
  assert.equal(await fs.readFile(file,'utf8'),'external update');
  assert.equal((await fs.readdir(path.dirname(file))).some(n=>n.startsWith('.mobile-')),false);
});

test('dev support exceptions allow files and structural directory with exact types only',async t=>{
  const {root,bridge}=await fixture(t);bridge.beginTask({root,mode:'dev'});
  await assert.rejects(bridge.writeText(path.join(root,'writerd_oplog'),'not a directory'));
  await assert.rejects(bridge.mkdir(path.join(root,'.openwrite_manifest.json')));
  await fs.writeFile(path.join(root,'writerd_oplog'),'not a directory');
  await assert.rejects(bridge.readText(path.join(root,'writerd_oplog')));
});

test('dev edits existing material with private raw-byte backup and atomic replacement',async t=>{
  const {root,runtimeDir,bridge}=await fixture(t);
  const file=path.join(root,'小说资料','setting.md');
  const original=Buffer.from([0xff,0xfe,0x2d,0x4e]);
  await fs.writeFile(file,original);
  const before=await fs.stat(file);
  bridge.beginTask({root,mode:'dev'});
  await bridge.writeText(file,'new material');
  assert.equal(await fs.readFile(file,'utf8'),'new material');
  assert.notEqual((await fs.stat(file)).ino,before.ino);
  const backups=await fs.readdir(path.join(runtimeDir,'backups'));
  assert.equal(backups.length,1);
  const backup=path.join(runtimeDir,'backups',backups[0]);
  assert.deepEqual(await fs.readFile(backup),original);
  assert.equal((await fs.stat(backup)).mode&0o777,0o600);
  assert.equal((await fs.stat(path.dirname(backup))).mode&0o777,0o700);
  await bridge.appendText(file,' appended');
  assert.equal(await bridge.readText(file),'new material appended');
});

test('dev archives candidates and completed outlines without overwriting conflicts',async t=>{
  const {root,bridge}=await fixture(t);
  bridge.beginTask({root,mode:'dev'});
  const source=path.join(root,'待确认','existing.md');
  const archive=path.join(root,'待确认','已处理','existing.md');
  await bridge.mkdir(path.dirname(archive));
  await bridge.rename(source,archive);
  assert.equal(await bridge.exists(source),false);
  assert.equal(await bridge.readText(archive),'original');
  const outline=path.join(root,'小说资料','细纲','已完成','outline.md');
  await bridge.copy(archive,outline);
  assert.equal(await bridge.readText(outline),'original');
  await assert.rejects(bridge.copy(archive,outline));
  await bridge.writeText(source,'candidate');
  await assert.rejects(bridge.rename(source,archive));
  assert.equal(await bridge.readText(source),'candidate');
  await assert.rejects(bridge.remove(archive));
});

test('dev only reads active root even if another project is allowed and limits support exceptions',async t=>{
  const {root,dir,runtimeDir,skillsDir}=await fixture(t);
  const other=path.join(dir,'other');
  await fs.mkdir(path.join(other,'小说资料'),{recursive:true});
  await fs.writeFile(path.join(other,'小说资料','secret.md'),'other work');
  const bridge=await createEngineFs({allowedProjects:[root,other],runtimeDir,skillsDir});
  bridge.beginTask({root,mode:'dev'});
  for(const action of [()=>bridge.list(other),()=>bridge.readText(path.join(other,'小说资料','secret.md')),()=>bridge.writeText(path.join(other,'小说资料','secret.md'),'bad'),()=>bridge.copy(path.join(root,'待确认','existing.md'),path.join(other,'小说资料','new.md'))])await assert.rejects(action());
  await bridge.writeText(path.join(root,'.openwrite_manifest.json'),'{}');
  await bridge.mkdir(path.join(root,'writerd_oplog'));
  await bridge.appendText(path.join(root,'writerd_oplog','log.jsonl'),'{}\n');
  assert.equal(await bridge.readText(path.join(root,'.openwrite_manifest.json')),'{}');
  for(const rel of ['.secret.md','writerd_oplog/secret.md','小说资料/.openwrite_manifest.json','小说资料/data.json'])await assert.rejects(bridge.writeText(path.join(root,rel),'bad'));
  await fs.link(path.join(root,'待确认','existing.md'),path.join(root,'小说资料','hard.md'));
  await assert.rejects(bridge.readText(path.join(root,'小说资料','hard.md')));
  await assert.rejects(bridge.writeText(path.join(root,'小说资料','hard.md'),'bad'));
  bridge.endTask();bridge.beginTask({root,mode:'readonly'});
  await assert.rejects(bridge.writeText(path.join(root,'.openwrite_manifest.json'),'bad'));
  await assert.rejects(bridge.mkdir(path.join(root,'小说资料','nested')));
});

test('engine accepts dev prompt and exposes busy across a mocked controller run',async t=>{
  const {engine,root}=await engineFixture(t);
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let entered,release;
  const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  globalThis.fetch=async(_url,request)=>{
    const body=JSON.parse(request.body);
    assert.ok(body.messages.some(m=>typeof m.content==='string'&&m.content.includes('dev fixture instruction')));
    entered();await gate;return sseResponse([{content:'dev complete'}]);
  };
  assert.equal(engine.busy(),false);
  const pending=engine.start({requestId:'dev-contract',projectId:'p',root,mode:'dev',text:'synthetic',prompt:'dev fixture instruction'});
  assert.equal(engine.busy(),true);
  const {taskId}=await pending;await ready;
  assert.equal(engine.busy(),true);release();
  const done=await until(engine,taskId,s=>s.state==='completed'||s.state==='failed');
  assert.equal(done.state,'completed');assert.equal(engine.busy(),false);
});

async function fixtureVersion(file) {
  const bytes=await fs.readFile(file),st=await fs.stat(file);
  return createHash('sha256').update(bytes).digest('hex')+':'+st.size+':'+st.mtimeMs;
}

test('expected source version rejects external edits before model reads and archive',async t=>{
  const {root,bridge}=await fixture(t),file=path.join(root,'待确认','existing.md');
  const version=await fixtureVersion(file);
  bridge.beginTask({root,mode:'dev',expectedFiles:[{path:file,version}]});
  assert.equal(await bridge.readText(file),'original');
  await fs.writeFile(file,'new external source');
  for(const action of [()=>bridge.readText(file),()=>bridge.writeText(file,'bad'),()=>bridge.rename(file,path.join(root,'待确认','已处理','existing.md')),()=>bridge.copy(file,path.join(root,'待确认','copy.md'))])await assert.rejects(action(),/VERSION_CONFLICT/);
  assert.equal(await fs.readFile(file,'utf8'),'new external source');
});

test('expected raw hash rejects same-size changes with restored mtime',async t=>{
  const {root,bridge}=await fixture(t),file=path.join(root,'待确认','existing.md');
  await fs.utimes(file,1700000000,1700000000);const version=await fixtureVersion(file);
  bridge.beginTask({root,mode:'dev',expectedFiles:[{path:file,version}]});
  await fs.writeFile(file,'modified');await fs.utimes(file,1700000000,1700000000);
  await assert.rejects(bridge.readText(file),/VERSION_CONFLICT/);
});

test('expected missing file advances after own create and writing appends',async t=>{
  const {root,bridge}=await fixture(t),file=path.join(root,'待确认','new.md');
  bridge.beginTask({root,mode:'writing',expectedFiles:[{path:file,version:null}]});
  await bridge.writeText(file,'first');await bridge.appendText(file,' second');assert.equal(await bridge.readText(file),'first second');bridge.endTask();
  const other=path.join(root,'章节内容','new.md');bridge.beginTask({root,mode:'dev',expectedFiles:[{path:other,version:null}]});
  await bridge.writeText(other,'first');await bridge.writeText(other,'second');assert.equal(await bridge.readText(other),'second');
});

test('expected absent target rejects later creation without overwriting',async t=>{
  const {root,bridge}=await fixture(t),file=path.join(root,'章节内容','target.md');
  bridge.beginTask({root,mode:'dev',expectedFiles:[{path:file,version:null}]});
  assert.equal(await bridge.exists(file),false);
  await fs.writeFile(file,'external chapter');
  await assert.rejects(bridge.writeText(file,'candidate'),/VERSION_CONFLICT/);
  await assert.rejects(bridge.readText(file),/VERSION_CONFLICT/);
  assert.equal(await fs.readFile(file,'utf8'),'external chapter');
});

test('expected versions advance only through own writes copies and moves',async t=>{
  const {root,bridge}=await fixture(t),source=path.join(root,'待确认','existing.md'),target=path.join(root,'章节内容','new.md'),copy=path.join(root,'小说资料','copy.md');
  bridge.beginTask({root,mode:'dev',expectedFiles:[{path:source,version:await fixtureVersion(source)},{path:target,version:null},{path:copy,version:null}]});
  await bridge.writeText(source,'adopted');await bridge.appendText(source,' version');assert.equal(await bridge.readText(source),'adopted version');
  await bridge.copy(source,copy);assert.equal(await bridge.readText(copy),'adopted version');
  await bridge.rename(source,target);assert.equal(await bridge.exists(source),false);assert.equal(await bridge.readText(target),'adopted version');
  await bridge.writeText(target,'own second edit');assert.equal(await bridge.readText(target),'own second edit');
  await fs.writeFile(source,'new source');await assert.rejects(bridge.readText(source),/VERSION_CONFLICT/);
});

test('expected paths accept at most three active-root category Markdown bindings',async t=>{
  const {root,dir,bridge}=await fixture(t),file=path.join(root,'待确认','existing.md'),version=await fixtureVersion(file);
  for(const expectedFiles of [[{path:path.join(dir,'outside.md'),version}],[{path:path.join(root,'.openwrite_manifest.json'),version}],[{path:file,version:'invalid'}],Array(4).fill({path:file,version}),[{path:file,version},{path:file,version}]])assert.throws(()=>bridge.beginTask({root,mode:'dev',expectedFiles}));
  bridge.beginTask({root,mode:'readonly',expectedFiles:[{path:file,version}]});assert.equal(await bridge.readText(file),'original');await assert.rejects(bridge.writeText(file,'bad'));
});

test('engine forwards trusted expected files into controller accesses',async t=>{
  const {root,engine}=await engineFixture(t),file=path.join(root,'待确认','existing.md'),version=await fixtureVersion(file);
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  globalThis.fetch=async()=>{if(++calls===1){await fs.writeFile(file,'external source');return sseResponse([{tool_calls:[{index:0,id:'bound-write',type:'function',function:{name:'file_write',arguments:JSON.stringify({operation:'write',path:'待确认/existing.md',content:'bad overwrite'})}}]}]);}return sseResponse([{content:'done'}]);};
  const {taskId}=await engine.start({requestId:'bound-tools',projectId:'p',root,text:'fixture',mode:'dev',expectedFiles:[{path:file,version}]});await until(engine,taskId,s=>s.state==='completed'||s.state==='failed');assert.equal(await fs.readFile(file,'utf8'),'external source');
});

test('SSE transport preserves UTF8 chunks and trailing line and HTTP classification',async()=>{
  const bytes=new TextEncoder().encode('data: 中文\r\ndata: last');
  const transport=createFetchTransport({fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(bytes.slice(0,8));c.enqueue(bytes.slice(8));c.close();}}))});
  const lines=[];
  await transport.stream({url:'https://example.test',headers:{},body:{}},{onLine:l=>lines.push(l),onError:e=>assert.fail(e)});
  assert.deepEqual(lines,['data: 中文','data: last']);
  const bad=createFetchTransport({fetchImpl:async()=>new Response('error',{status:429})});
  const errors=[];
  await bad.stream({url:'https://example.test',headers:{},body:{}},{onLine:l=>errors.push(l),onError:e=>assert.fail(e)});
  assert.match(errors[0],/^__HTTP_ERROR__429[|]/);
});

test('SSE abort interrupts a pending network fetch',async()=>{
  let entered;
  const ready=new Promise(r=>entered=r);
  const transport=createFetchTransport({fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});entered();})});
  const errors=[];
  const run=transport.stream({url:'https://example.test',headers:{},body:{}},{onLine:()=>{},onError:e=>errors.push(e)});
  await ready;
  transport.abortActive();
  await run;
  assert.deepEqual(errors,['请求已中止']);
});
