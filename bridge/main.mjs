import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomSecret,createCodec} from '../lib/secure-channel.mjs';
import {relayClient,subscribe,publish} from '../lib/relay.mjs';
import {HostProtocol} from './host-protocol.mjs';
import {DataStore} from './data-store.mjs';
import {createEngine} from '../.bridge/engine.mjs';
const privateDir=path.join(os.homedir(),'.deepcompose-mobile');
await fs.mkdir(privateDir,{recursive:true,mode:0o700});
const privateStat=await fs.lstat(privateDir);if(!privateStat.isDirectory()||privateStat.isSymbolicLink())throw Error('PRIVATE_DIRECTORY_DENIED');await fs.chmod(privateDir,0o700);
const configPath=path.join(privateDir,'connection.json');
let config;try{const s=await fs.lstat(configPath);if(s.isSymbolicLink()||!s.isFile()||s.nlink!==1)throw Error('CONFIG_DENIED');config=JSON.parse(await fs.readFile(configPath,'utf8'));await fs.chmod(configPath,0o600);}catch(error){if(error.code!=='ENOENT')throw Error('PRIVATE_CONFIG_FAILED');}
if(!config||process.argv.includes('--rotate')){config={version:1,secret:randomSecret(),createdAt:Date.now(),expiresAt:Date.now()+7*24*3600000};await fs.writeFile(configPath,JSON.stringify(config),{mode:0o600});await fs.chmod(configPath,0o600);}
if(Date.now()>config.expiresAt)throw Error('PAIRING_EXPIRED_ROTATE_REQUIRED');
const pairingUrl='https://3470437923-cloud.github.io/deepcompose-mobile-preview/#pair='+config.secret;
await fs.writeFile(path.join(privateDir,'pairing-url.txt'),pairingUrl,{mode:0o600});
if(process.argv.includes('--print-link')){console.log(pairingUrl);process.exit(0);}
const prefsPath=path.join(os.homedir(),'Library','Application Support','com.writerd','writerD','shared_preferences.json');
const raw=JSON.parse(await fs.readFile(prefsPath,'utf8'));
const docs=await fs.realpath(path.join(os.homedir(),'Documents'));
const booksRoot=await fs.realpath(raw['flutter.custom_novels_dir']||path.join(os.homedir(),'AI写小说'));
const skillsDir=path.resolve(raw['flutter.custom_skills_dir']||path.join(docs,'skills'));
const runtimeDir=path.join(privateDir,'runtime');await fs.mkdir(runtimeDir,{recursive:true,mode:0o700});
const store=new DataStore({booksRoot,sessionDirs:[path.join(docs,'writerd_sessions'),path.join(runtimeDir,'sessions')]});
const projects=await store.projects();
const engine=await createEngine({prefsPath,booksRoot,skillsDir,runtimeDir,allowedProjects:projects.map(p=>store.root(p.id))});
const startedAt=new Date().toISOString();
const current=projects.find(p=>store.root(p.id)===path.resolve(raw['flutter.current_novel_project']||'/nonexistent'));
function requireString(value,max=90){if(typeof value!=='string'||value.length<1||value.length>max)throw Error('INVALID_INPUT');return value;}
const sensitive=new Set([config.secret]);
function collectKeys(value){if(!value||typeof value!=='object')return;for(const [name,v] of Object.entries(value)){if(typeof v==='string'&&/(api.?key|access.?token|secret)/i.test(name)&&v.length>=6)sensitive.add(v);else if(v&&typeof v==='object')collectKeys(v);else if(typeof v==='string'&&/provider/i.test(name)){try{collectKeys(JSON.parse(v));}catch{}}}}
collectKeys(raw);
function redact(value){if(typeof value==='string'){for(const key of sensitive)value=value.replaceAll(key,'[已隐藏密钥]');return value;}if(Array.isArray(value))return value.map(redact);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v)]));return value;}
async function dispatch(method,params,request){
 if(method==='hello')return{device:'我的 Mac',version:'1.1.4 / Mobile 0.2',capabilities:['projects','files','sessions','chat-readonly','new-candidate','task-resume'],model:engine.info().model,configured:engine.info().configured,currentProjectId:current?.id??null,connection:'end-to-end encrypted',startedAt,pairingExpiresAt:config.expiresAt};
 if(method==='projects.list')return store.projects();
 if(method==='files.list')return store.files(requireString(params.projectId),requireString(params.category));
 if(method==='file.read')return store.read(requireString(params.projectId),requireString(params.fileId));
 if(method==='sessions.list')return store.sessions(requireString(params.projectId));
 if(method==='session.read')return store.session(requireString(params.projectId),requireString(params.sessionId));
 if(method==='task.start'){const projectId=requireString(params.projectId);const root=store.root(projectId);const text=requireString(params.text,8000);const mode=params.mode??'readonly';if(!['readonly','writing'].includes(mode))throw Error('MODE_DENIED');const result=await engine.start({requestId:request.id,projectId,root,text,mode});return result;}
 if(method==='task.get')return engine.get(requireString(params.taskId));
 if(method==='task.stop')return engine.stop(requireString(params.taskId));
 if(method==='task.answer')return engine.answer({taskId:requireString(params.taskId),questionId:requireString(params.questionId),answers:params.answers});
 throw Error('METHOD_DENIED');
}
const protocol=new HostProtocol({secret:config.secret,dispatch:async(...args)=>redact(await dispatch(...args))});
const codec=await createCodec(config.secret);const topic='dc-mobile/v1/'+codec.topicId;
const transport=relayClient('desktop');
transport.on('connect',async()=>{try{await subscribe(transport,topic+'/request');console.log('DeepCompose mobile: encrypted public relay ready; projects='+projects.length);}catch{console.error('DeepCompose mobile: relay subscription failed');}});
transport.on('message',(name,payload,packet)=>{if(packet.retain||name!==topic+'/request'||payload.length>400*1024)return;void protocol.receive(payload.toString()).then(reply=>reply?publish(transport,topic+'/response',reply):null).catch(()=>{});});
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>{transport.end(true);process.exit(0)});
console.log('DeepCompose mobile bridge started. Pairing link stored locally with owner-only permissions.');
