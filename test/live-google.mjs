// Opt-in live acceptance test. Creates one labelled upload, verifies it, then cleans up only its own data.
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { configFromEnv } from '../server/config.js';
import { createApp } from '../server/index.js';
import { Tokens } from '../server/core.js';

const config=configFromEnv();
assert.equal(config.mode,'google','請先設定 MODE=google。');
config.stateless=true;
config.dataDir=path.resolve('work',`live-${randomUUID()}`);
const app=await createApp(config);
await app.google.probe();
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${app.server.address().port}`;
async function request(route,options={}) {
  const response=await fetch(base+route,options),body=await response.json();
  assert.equal(response.status,200,body.error || JSON.stringify(body));return body;
}
let entry;
try {
  const login=await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:await app.google.password()})});
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
  const job=await request('/api/uploads',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${login.token}`},body:JSON.stringify({id:randomUUID(),grade:5,classroom:1,seats:[1,3,17,22],topic:'系統連線測試',description:'Collect.Silomo 自動驗收測試，完成後清理。',filename:'test.png',size:image.length})});
  entry=new Tokens(config.secret).open(job.uploadToken,'upload').job;
  const done=await request(`/api/uploads/${job.id}`,{method:'PUT',headers:{Authorization:`Bearer ${job.uploadToken}`,'X-Chunk-Offset':'0','Content-Type':'application/octet-stream'},body:image});
  assert.equal(done.state,'complete');assert(await app.google.completed(entry));assert(await app.google.hasRecord(entry.id));
  await request(`/api/uploads/${job.id}`,{headers:{Authorization:`Bearer ${job.uploadToken}`}});
  assert(await app.google.hasRecord(entry.id));
  console.log(JSON.stringify({result:'PASS',checks:['即時密碼登入','無狀態實際上傳','共用雲端硬碟檔案驗證','原子且不重複的五欄紀錄'],filename:done.name},null,2));
} finally {
  try {
    if(entry) {
      if(await app.google.completed(entry)) {
        await app.google.json(`https://www.googleapis.com/drive/v3/files/${entry.fileId}?supportsAllDrives=true`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({trashed:true})});
        console.log('測試檔案已移至垃圾桶。');
      }
      if(await app.google.hasRecord(entry.id)) { await app.google.removeTestRecord(entry);console.log('測試紀錄已清除。'); }
    }
  } finally { await new Promise(r=>app.server.close(r)); }
}
