import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { send, providerOf } from 'deepcompose-core/ai/controller';
import { parsePrefs } from 'deepcompose-core/prefs';
import { setFs } from 'deepcompose-core/fsbridge';
import { createEngineFs, createFetchTransport, noLinks, privateMkdir } from './engine-fs.mjs';

const MAX_TEXT = 24000;
const MAX_MESSAGES = 16000;
const ACTIVE_STATES = new Set(['running', 'waiting']);
type Options = { prefsPath:string; booksRoot:string; skillsDir:string; runtimeDir:string; allowedProjects:string[] };
type Start = {requestId:string; projectId:string; root:string; text:string; mode?:'readonly'|'writing'};
type Task = {id:string;projectId:string;state:string;text:string;messages:{role:string;text:string}[];toolStatus:string;error?:string;question?:{id:string;items:any[]};startedAt:string;updatedAt:string};

// 配置只在本机读取，不通过 FsBridge 或远端任务提供任何配置读取能力。
async function readPrefs(file:string) {
  await noLinks(file);
  const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const st=await h.stat();
    if(!st.isFile()||st.nlink!==1||st.size>1024*1024)throw new Error('本机配置不可读');
    return parsePrefs(await h.readFile('utf8'));
  } finally {await h.close();}
}

export async function createEngine(options:Options) {
  const runtime=path.resolve(options.runtimeDir);
  const projects=options.allowedProjects.map(p=>path.resolve(p));
  const prefs=await readPrefs(options.prefsPath);
  const cfg=providerOf(prefs);
  const bridge=await createEngineFs({...options,runtimeDir:runtime});
  setFs(bridge);
  const dirs:any={
    booksRoot:path.resolve(options.booksRoot),skillsDir:path.resolve(options.skillsDir),
    sessionsDir:path.join(runtime,'sessions'),snapshotsDir:path.join(runtime,'snapshots'),
    usageStatsFile:path.join(runtime,'usage','usage_stats.json'),
    memosFile:path.join(runtime,'memos.json'),prefsDir:runtime,prefsFile:options.prefsPath,
    quickPromptsFile:path.join(runtime,'quick_prompts.json'),logDir:path.join(runtime,'diagnostics'),logFile:path.join(runtime,'diagnostics','disabled.log'),
  };
  const tasksDir=path.join(runtime,'tasks');
  for(const dir of [runtime,tasksDir,dirs.sessionsDir,dirs.snapshotsDir,path.dirname(dirs.usageStatsFile)])await privateMkdir(dir);
  const tasks=new Map<string,Task>();
  const requests=new Map<string,string>();
  const requestOf=new Map<string,string>();
  const pendingIntents=new Map<string,Promise<void>>();
  let active:any=null;
  let starting=false;
  let queue:Promise<any>=Promise.resolve();
  const credentials=[prefs.apiKey,prefs.officialApiKey,...(prefs.savedProviders??[]).map((p:any)=>p.apiKey)].filter((s:any)=>typeof s==='string'&&s.length>0);
  const safeText=(s:unknown,max=MAX_TEXT)=>{
    let text=typeof s==='string'?s:'';
    for(const secret of credentials)text=text.split(secret).join('[已隐藏]');
    return text.slice(0,max);
  };
  const clone=(task:Task)=>JSON.parse(JSON.stringify(task));
  function textMessages(messages:any[]) {
    let budget=MAX_MESSAGES;
    return messages.filter(m=>m&&(m.role==='user'||m.role==='assistant')).slice(-50).map(m=>{const text=safeText(m.text,Math.min(MAX_TEXT,budget));budget-=text.length;return{role:m.role,text};});
  }
  function persist(task:Task) {
    const content=JSON.stringify({requestId:requestOf.get(task.id),...task});
    const run=queue.then(async()=>{
      const dest=path.join(tasksDir,task.id+'.json');
      const temp=path.join(tasksDir,randomUUID()+'.tmp');
      await bridge.writeText(temp,content);
      await noLinks(dest);
      await fs.rename(temp,dest);
    });
    queue=run.catch(()=>{});
    return run;
  }
  // 重启只恢复可查询的结果和去重映射，绝不重放未确认完成的模型请求。
  for(const entry of await bridge.list(tasksDir)) {
    if(entry.isDir||!/^[-a-f0-9]{36}[.]json$/.test(entry.name))continue;
    try {
      const saved=JSON.parse(await bridge.readText(entry.path));
      if(typeof saved.requestId!=='string'||saved.id+'.json'!==entry.name||typeof saved.projectId!=='string')continue;
      const {requestId,...task}=saved;
      if(!['running','waiting','completed','failed','stopped'].includes(task.state))continue;
      task.text=safeText(task.text);
      task.messages=Array.isArray(task.messages)?textMessages(task.messages):[];
      tasks.set(task.id,task);
      requests.set(requestId,task.id);
      requestOf.set(task.id,requestId);
      if(ACTIVE_STATES.has(task.state)) {
        task.state='failed';task.error='连接进程曾重启，任务未自动重试';delete task.question;
        task.updatedAt=new Date().toISOString();await persist(task);
      }
    } catch { /* 损坏的任务文件不执行、不向远端泄露本机路径。 */ }
  }
  function lookup(id:string) {
    const task=tasks.get(id);
    if(!task)throw new Error('任务不存在');
    return task;
  }
  function finishWaiting(run:any) {
    if(run.resolveQuestion) {const resolve=run.resolveQuestion;run.resolveQuestion=null;resolve(run.questionItems.map(()=>[]));}
    delete run.task.question;
  }
  function cancel(run:any,reason:string) {
    run.signal.aborted=true;
    bridge.endTask();
    run.transport.abortActive();
    finishWaiting(run);
    run.task.state='stopped';run.task.error=reason;run.task.updatedAt=new Date().toISOString();
  }
  function schedule(run:any) {
    if(run.flushTimer)return;
    run.flushTimer=setTimeout(()=>{run.flushTimer=null;void persist(run.task).catch(()=>{cancel(run,'任务保存失败，已停止');});},200);
    run.flushTimer.unref?.();
  }
  async function execute(run:any,input:Start) {
    try {
      const result=await send({
        dirs,prefs:{...prefs,systemPrompt:prefs.systemPrompt+'\n手机任务：只能读取已授权作品资料。写作模式仅允许新建待确认目录下的Markdown候选，后续只能追加本任务新建候选；禁止覆盖既有候选与正式正文。'},
        session:null,projectRoot:input.root,userText:input.text,transport:run.transport,
        mode:input.mode??'readonly',signal:run.signal,allowedDirs:[],confirmExternal:async()=>false,
        onEvent(event:any) {
          if(run.signal.aborted)return;
          const task=run.task;
          if(event.type==='text_delta')task.text=(task.text+safeText(event.text)).slice(0,MAX_TEXT);
          if(event.type==='tool_started')task.toolStatus='正在执行 '+safeText(event.call?.name,80);
          if(event.type==='tool_completed')task.toolStatus='工具已完成';
          task.updatedAt=new Date().toISOString();schedule(run);
        },
        askQuestions:async(items:any[])=>{
          if(run.signal.aborted)return items.map(()=>[]);
          if(!Array.isArray(items)||items.length>10)throw new Error('提问数量超限');
          // 远端只能选择当前问题给出的选项，不能用答案注入路径授权。
          const questionItems=items.map(q=>({question:safeText(q.question,2000),options:(q.options??[]).slice(0,30).map(o=>({label:safeText(o.label,500),description:safeText(o.description,1000)})),multi_select:!!q.multi_select}));
          if(JSON.stringify(questionItems).length>6000)throw new Error('提问内容超限');
          run.questionItems=questionItems;
          const waiting=new Promise<string[][]>(resolve=>run.resolveQuestion=resolve);
          run.task.state='waiting';run.task.question={id:randomUUID(),items:questionItems};
          run.task.updatedAt=new Date().toISOString();
          await persist(run.task);
          if(run.signal.aborted)finishWaiting(run);
          return waiting;
        },
      });
      run.task.text=safeText(result.session.messages.filter((m:any)=>m.role==='assistant'&&m.text).map((m:any)=>m.text).join('\n'));
      run.task.messages=textMessages(result.session.messages);
      if(!run.signal.aborted) {
        run.task.state=result.error?'failed':'completed';
        if(result.error)run.task.error='模型执行失败，请在电脑检查提供商配置或网络';
      }
    } catch {
      if(!run.signal.aborted){run.task.state='failed';run.task.error='任务执行失败，请在电脑检查配置或授权目录';}
    } finally {
      clearTimeout(run.deadline);clearTimeout(run.flushTimer);
      finishWaiting(run);
      run.task.toolStatus=run.task.state==='completed'?'已完成':run.task.state==='stopped'?'已停止':'执行结束';
      run.task.updatedAt=new Date().toISOString();
      try{await persist(run.task);}finally{bridge.endTask();if(active===run)active=null;}
    }
  }
  return {
    info(){return{model:safeText(cfg?.model??'',200),configured:!!cfg};},
    async start(input:Start) {
      if(typeof input?.requestId!=='string'||!input.requestId||input.requestId.length>200)throw new Error('请求ID无效');
      const duplicate=requests.get(input.requestId);
      if(duplicate) {try {await pendingIntents.get(input.requestId);} catch {throw new Error('任务意图保存失败');}return{taskId:duplicate};}
      if(starting||active)throw new Error('已有任务正在执行');
      if(!cfg)throw new Error('电脑尚未配置模型');
      if(typeof input.projectId!=='string'||!input.projectId||typeof input.root!=='string'||!projects.includes(path.resolve(input.root)))throw new Error('作品未授权');
      if(typeof input.text!=='string'||!input.text.trim()||input.text.length>8000)throw new Error('任务内容须为1至8000字');
      if(input.mode!==undefined&&input.mode!=='readonly'&&input.mode!=='writing')throw new Error('任务模式无效');
      if(tasks.size>=2000)throw new Error('本机任务存储已满，请整理后再试');
      starting=true;
      const now=new Date().toISOString();
      const task:Task={id:randomUUID(),projectId:input.projectId,state:'running',text:'',messages:[{role:'user',text:safeText(input.text)}],toolStatus:'正在连接模型',startedAt:now,updatedAt:now};
      requests.set(input.requestId,task.id);requestOf.set(task.id,input.requestId);tasks.set(task.id,task);
      try {
        const intent=persist(task);pendingIntents.set(input.requestId,intent);await intent;
        bridge.beginTask({root:input.root,mode:input.mode??'readonly'});
        const run:any={task,signal:{aborted:false},transport:createFetchTransport(),resolveQuestion:null,flushTimer:null};
        active=run;
        run.deadline=setTimeout(()=>{cancel(run,'任务超过15分钟，已停止');void persist(task).catch(()=>{});},15*60*1000);
        run.deadline.unref?.();
        run.done=execute(run,input).catch(()=>{task.state='failed';task.error='任务保存失败';});
        return{taskId:task.id};
      } catch {
        task.state='failed';task.error='任务未能启动';
        await persist(task).catch(()=>{});
        throw new Error('任务未能启动');
      } finally {starting=false;pendingIntents.delete(input.requestId);}
    },
    async get(id:string) {
      const task=lookup(id),run=active?.task===tasks.get(id)?active:null;
      await persist(task);
      // 状态也可能在上面的写盘 await 期间变成终态，因此必须在 await 后重新检查。
      if(run&&!ACTIVE_STATES.has(task.state)) {await run.done;await persist(task);}
      return clone(task);
    },
    async answer({taskId,questionId,answers}:{taskId:string;questionId:string;answers:string[][]}) {
      const task=lookup(taskId),run=active;
      if(!run||run.task!==task||task.state!=='waiting'||task.question?.id!==questionId||!run.resolveQuestion)throw new Error('问题已过期');
      const items=task.question.items;
      if(!Array.isArray(answers)||answers.length!==items.length||answers.some((a,i)=>!Array.isArray(a)||!a.length||(!items[i].multi_select&&a.length!==1)||new Set(a).size!==a.length||a.some(label=>typeof label!=='string'||!items[i].options.some(o=>o.label===label))))throw new Error('答案不符合当前问题选项');
      const resolve=run.resolveQuestion;
      delete task.question;task.state='running';task.updatedAt=new Date().toISOString();
      try {await persist(task);} catch {cancel(run,'任务保存失败，已停止');throw new Error('答案保存失败');}
      run.resolveQuestion=null;resolve(run.signal.aborted?items.map(()=>[]):answers);
      return clone(task);
    },
    async stop(id:string) {
      const task=lookup(id);
      if(active?.task===task) {const run=active;cancel(run,'用户已停止任务');await run.done;}
      await persist(task);
      return clone(task);
    },
  };
}
