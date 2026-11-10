import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
