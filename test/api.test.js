import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/index.js';
import { configFromEnv } from '../server/config.js';
import { MockGoogle } from '../server/google.js';
import { CHUNK_SIZE, Store } from '../server/core.js';
await mkdir(path.resolve('work'), { recursive: true });
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
async function setup(t){
  const dir=await mkdtemp(path.resolve('work','collect-test-'));
  const google=new MockGoogle('1234');const app=await createApp(configFromEnv({DATA_DIR:dir,SESSION_SECRET:'test-secret',MODE:'mock'}),google);
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});});
  async function request(route,{method='GET',token,body,headers={}}={}){
    const res=await fetch(base+route,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...headers},body:Buffer.isBuffer(body)?body:body?JSON.stringify(body):undefined});return {status:res.status,data:await res.json()};
  }
  const login=await request('/api/login',{method:'POST',body:{password:'1234'}});
  const metadata=()=>({id:randomUUID(),grade:5,classroom:1,seats:[1,3,17,22],topic:'光的折射',description:'=IMPORTXML("test")',filename:'test.png',size:png.length});
  const init=(body=metadata(),token=login.data.token)=>request('/api/uploads',{method:'POST',token,body});
  const chunk=(job,body=png,start=0)=>request(`/api/uploads/${job.id}`,{method:'PUT',token:job.uploadToken,headers:{'X-Chunk-Offset':String(start)},body});
  const status=job=>request(`/api/uploads/${job.id}`,{token:job.uploadToken});
  return {...app,request,login,metadata,init,chunk,status,dir};
}
test('完成上傳、五欄紀錄、重複提交與權限隔離',async t=>{
  const a=await setup(t);const input=a.metadata();const x=await a.init(input);assert.equal(x.status,200);
  const duplicate=await a.init(input);assert.equal(duplicate.data.id,x.data.id);assert.equal(a.google.files.size,1);
  const done=await a.chunk(x.data);assert.equal(done.data.state,'complete');assert.equal(a.google.records.size,1);
  assert.equal([...a.google.records.values()][0][4],'=IMPORTXML("test")');
  await a.chunk(x.data);await a.status(x.data);assert.equal(a.google.records.size,1);
  assert.equal((await a.request(`/api/uploads/${x.data.id}`,{token:a.login.data.token})).status,401);
  assert.equal((await a.request('/api/config',{headers:{Origin:'https://evil.example'}})).status,403);
});
test('密碼每次核對：舊登入不可新上傳、已開始工作可完成',async t=>{
  const a=await setup(t);const job=(await a.init()).data;a.google.currentPassword='5678';
  assert.equal((await a.init()).status,401);assert.equal((await a.request('/api/login',{method:'POST',body:{password:'1234'}})).status,401);
  assert.equal((await a.request('/api/login',{method:'POST',body:{password:'5678'}})).status,200);
  assert.equal((await a.chunk(job)).data.state,'complete');
});
test('Sheet 失敗後以同列補寫，不重傳檔案；狀態可從磁碟恢復',async t=>{
  const a=await setup(t);const job=(await a.init()).data;a.google.failWrites=true;assert.equal((await a.chunk(job)).status,503);
  const disk=new Store(a.dir);await disk.open();assert.equal(disk.state.jobs[job.id].state,'recording');assert.equal(disk.state.jobs[job.id].offset,png.length);
  a.google.failWrites=false;assert.equal((await a.status(job)).data.state,'complete');assert.equal(a.google.records.size,1);
});
test('100MB 分塊上傳、錯位拒絕、丟失回應後同步進度',async t=>{
  const a=await setup(t);const job=(await a.init({...a.metadata(),size:100000000})).data;
  const buffer=Buffer.alloc(CHUNK_SIZE);png.copy(buffer);
  let result=await a.chunk(job,buffer);assert.equal(result.data.offset,CHUNK_SIZE);
  assert.equal((await a.chunk(job,buffer,0)).status,409);
  let offset=(await a.status(job)).data.offset;
  while(offset<100000000){result=await a.chunk(job,buffer.subarray(0,Math.min(CHUNK_SIZE,100000000-offset)),offset);assert.equal(result.status,200);offset=result.data.offset;}
  assert.equal(result.data.state,'complete');assert.equal(a.google.records.size,1);
});
test('阻擋超限、偽裝格式與沒有登入的請求',async t=>{
  const a=await setup(t);assert.equal((await a.init({...a.metadata(),size:100000001})).status,400);
  assert.equal((await a.init(a.metadata(),'bad-token')).status,401);
  const job=(await a.init()).data;assert.equal((await a.chunk(job,Buffer.alloc(png.length))).status,400);assert.equal(a.google.records.size,0);
});
test('多人同時繳交分配不同紀錄列',async t=>{
  const a=await setup(t);const jobs=await Promise.all(Array.from({length:6},()=>a.init()));
  const results=await Promise.all(jobs.map(j=>a.chunk(j.data)));assert(results.every(r=>r.data.state==='complete'));
  assert.equal(a.google.records.size,6);assert.equal(new Set(Object.values(a.store.state.jobs).map(j=>j.row)).size,6);
});
test('登入節流',async t=>{
  const a=await setup(t);let r;for(let i=0;i<16;i++)r=await a.request('/api/login',{method:'POST',body:{password:'wrong'}});assert.equal(r.status,429);
});
test('無本機狀態模式可在服務重啟後續傳',async t=>{
  const dir=await mkdtemp(path.resolve('work','collect-stateless-')),google=new MockGoogle('1234');
  const config=configFromEnv({DATA_DIR:dir,SESSION_SECRET:'a'.repeat(64),MODE:'mock'});config.stateless=true;
  async function start(){const app=await createApp(config,google);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return app;}
  async function call(app,route,{method='GET',token,body,headers={}}={}){const base=`http://127.0.0.1:${app.server.address().port}`;const response=await fetch(base+route,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...headers},body:Buffer.isBuffer(body)?body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
  let app=await start();const login=(await call(app,'/api/login',{method:'POST',body:{password:'1234'}})).data;
  const input={id:randomUUID(),grade:5,classroom:1,seats:[1],topic:'重啟測試',description:'',filename:'test.png',size:CHUNK_SIZE+png.length};
  let job=(await call(app,'/api/uploads',{method:'POST',token:login.token,body:input})).data;
  const initialToken=job.uploadToken,first=Buffer.alloc(CHUNK_SIZE);png.copy(first);
  await call(app,`/api/uploads/${job.id}`,{method:'PUT',token:initialToken,headers:{'X-Chunk-Offset':'0'},body:first}); // 模擬回應遺失
  await new Promise(r=>app.server.close(r));app=await start();
  job=(await call(app,`/api/uploads/${job.id}`,{token:initialToken})).data;
  assert.equal(job.offset,CHUNK_SIZE);assert.notEqual(job.uploadToken,initialToken);
  const done=await call(app,`/api/uploads/${job.id}`,{method:'PUT',token:job.uploadToken,headers:{'X-Chunk-Offset':String(CHUNK_SIZE)},body:png});
  assert.equal(done.data.state,'complete');assert.equal(google.records.size,1);
  await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});
});
