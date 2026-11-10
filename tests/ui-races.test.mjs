import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../web/app.mjs',import.meta.url),'utf8');
function fn(name,next){return source.slice(source.indexOf(name),source.indexOf(next,source.indexOf(name)));}
const functions=[fn('function showReader(','function closeReader('),fn('function closeReader(','function updateReaderActions('),fn('function startEdit(','function cancelEdit('),fn('async function readFile(','function splitFileChunks('),fn('function splitFileChunks(','async function saveReader('),fn('async function saveReader(','async function createFile('),fn('async function createFile(','async function showOperationTask('),fn('async function readSession(','function activeTask(')].join(String.fromCharCode(10));
function fixture(){
 const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false,replaceChildren(){}});return nodes.get(id);};
 const c={generation:1,readRequest:0,connection:'connected',selected:{id:'p',name:'fixture'},category:'chapters',files:[],maxFileBytes:2*1024*1024,readerFocus:null,readerBusy:false,readerFile:null,editor:{hidden:true,value:'',focus(){}},editTools:{hidden:true},reader:{open:false,showModal(){this.open=true;},close(){this.open=false;}},sheet:{open:true,close(){this.open=false;}},document:{activeElement:null,querySelectorAll(){return [];}},projects:[{id:'p',name:'fixture'}],$: $,TextEncoder,readerStatus(text){$('reader-status').textContent=text;},updateReaderActions(){},renderFiles(){},allowReaderLeave(){return true;},readerDirty(){return !!c.readerFile&&!c.editor.hidden&&c.editor.value!==c.readerFile.content;},openProject:async()=>{},errorText(){return 'ERROR';},fileError(){return 'ERROR';},prompt(){return 'new.md';}};
 vm.createContext(c);vm.runInContext(functions,c);return c;
}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function draft(c){c.reader.open=true;c.readerFile={complete:true,version:'v1',content:'saved fixture',fileId:'existing',projectId:'p'};c.editor.hidden=false;c.editor.value='unsaved fixture';}
test('stale session response cannot replace a newer reader draft or prompt in background',async()=>{
 const c=fixture(),d=deferred();c.rpc=()=>d.promise;const pending=c.readSession('p',{id:'s'});
 c.showReader('fixture','file.md','saved fixture','');draft(c);d.resolve({title:'history',messages:[]});await pending;
 assert.equal(c.editor.value,'unsaved fixture');assert.equal(c.readerFile.fileId,'existing');
});
test('closed sheet and busy reader both discard delayed history responses',async()=>{
 for(const state of ['closed','busy','disconnected','reader-closed']){const c=fixture(),d=deferred();c.rpc=()=>d.promise;const pending=c.readSession('p',{id:'s'});draft(c);if(state==='closed')c.sheet.open=false;else if(state==='busy')c.readerBusy=true;else if(state==='disconnected')c.generation++;else{c.closeReader();draft(c);}d.resolve({title:'history',messages:[]});await pending;assert.equal(c.editor.value,'unsaved fixture');}
});
test('latest session selection wins when responses arrive out of order',async()=>{
 const c=fixture(),a=deferred(),b=deferred();c.rpc=(_m,p)=>p.sessionId==='a'?a.promise:b.promise;const first=c.readSession('p',{id:'a'}),second=c.readSession('p',{id:'b'});a.resolve({title:'older',messages:[]});await first;assert.equal(c.sheet.open,true);b.resolve({title:'newer',messages:[]});await second;assert.equal(c.$('reader-title').textContent,'newer');
});
test('file loading owns the request created by its new reader',async()=>{
 const c=fixture();c.loadFullFile=async(_p,_f,current)=>{assert.equal(current(),true);return {complete:true,content:'loaded fixture',version:'v2'};};await c.readFile({id:'p',name:'fixture'},{id:'f',name:'f.md',category:'chapters'});assert.equal(c.readerFile.content,'loaded fixture');assert.equal(c.readerFile.fileId,'f');
});
test('a canceled new-file reader never restarts editing a different dirty file',async()=>{
 const c=fixture(),d=deferred();c.rpc=()=>d.promise;const pending=c.createFile('chapters');draft(c);c.allowReaderLeave=()=>false;d.resolve({id:'new'});await pending;assert.equal(c.editor.value,'unsaved fixture');
});
test('saved prose with metadata warning remains saved and discloses missing reflow baseline',async()=>{
 const c=fixture();draft(c);c.rpc=async method=>method==='file.write.begin'?{uploadId:'u'}:method==='file.write.commit'?{version:'v2',warning:'BACKUP_METADATA_FAILED'}:{};await c.saveReader();assert.equal(c.readerFile.content,'unsaved fixture');assert.equal(c.readerFile.version,'v2');assert.equal(c.editor.hidden,true);assert.equal(c.$('reader-status').textContent,'正文已保存，回流编辑基线未登记');
});
