import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AppError, assert, Store, Locks, Tokens, validate, taipei, filename, checkSignature, equal, CHUNK_SIZE, MAX_SIZE } from './core.js';
import { Google, MockGoogle } from './google.js';
import { configFromEnv } from './config.js';
import { Queue } from './queue.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
async function readBody(req, max) {
  const buffer=Buffer.allocUnsafe(max); let length=0;
  for await (const part of req) { assert(length+part.length<=max,'請求內容過大。',413); part.copy(buffer,length);length+=part.length; }
  return buffer.subarray(0,length);
}
async function readJSON(req) { try { return JSON.parse((await readBody(req,20_000)).toString()); } catch(e) { if(e instanceof AppError) throw e; throw new AppError(400,'資料格式錯誤。'); } }
export async function createApp(config, injected) {
  const google = injected || (config.mode==='google' ? new Google(config) : new MockGoogle(config.mockPassword));
  const store = config.stateless ? {state:{jobs:{}},save:async()=>{}} : new Store(config.dataDir); if(!config.stateless) await store.open();
  const locks=new Locks(), tokens=new Tokens(config.secret), attempts=new Map();
  const uploads=new Queue(4,32), controls=new Queue(4,64);
  const reply=(res,status,data)=> { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
  const bearer=req=>String(req.headers.authorization || '').replace(/^Bearer /,'');
  const view=job=>({ id:job.id, name:job.name, size:job.meta.size, offset:job.offset, state:job.state, chunkSize:CHUNK_SIZE, mode:config.mode });
  async function finish(job) {
    if (job.state==='complete') return;
    if(config.stateless) {
      job.state='recording';
      await locks.run('sheet',()=>google.writeRecord(job));
      job.state='complete';return;
    }
    job.state='recording'; await store.save();
    await locks.run('sheet', async()=> {
      if (!job.row) {
        store.state.nextRow=Math.max(store.state.nextRow || 2, await google.nextRow());
        job.row=store.state.nextRow++;
        await store.save();
      }
      await google.writeRow(job.row,[job.time.display,`50${job.meta.classroom}`,job.meta.seats.map(n=>String(n).padStart(2,'0')).join('.'),job.meta.topic,job.meta.description]);
      job.state='complete'; await store.save();
    });
  }
  async function sync(job) {
    if(job.state==='complete') return;
    if(job.state==='recording') { await finish(job); return; }
    const result=await google.status(job); job.offset=result.offset;
    if(result.complete) await finish(job); else await store.save();
  }
  const server=http.createServer(async(req,res)=> {
    let releaseControl;
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url=new URL(req.url,'http://localhost');
      const origin=req.headers.origin;
      if(origin) {
        assert(config.origins.includes(origin),'此網站來源未獲允許。',403);
        res.setHeader('Access-Control-Allow-Origin',origin); res.setHeader('Vary','Origin');
        res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,X-Chunk-Offset');
      }
      if(req.method==='OPTIONS') { res.writeHead(204);res.end();return; }
      if(url.pathname==='/api/health' && req.method==='GET') return reply(res,200,{ok:true,mode:config.mode});
      if(url.pathname==='/api/config' && req.method==='GET') return reply(res,200,{mode:config.mode,maxSize:MAX_SIZE,chunkSize:CHUNK_SIZE});
      if(url.pathname.startsWith('/api/') && req.method!=='PUT') releaseControl=await controls.acquire(req,res);
      if(url.pathname==='/api/login' && req.method==='POST') {
        const address=config.trustProxy ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').pop().trim() : req.socket.remoteAddress;
        const now=Date.now();
        for(const [key,v] of attempts) if(v.until<now) attempts.delete(key);
        assert(attempts.size<10000 || attempts.has(address),'目前登入流量較高，請稍後重試。',429);
        const limit=attempts.get(address)||{count:0,until:now+60_000};
        assert(limit.count<15,'登入嘗試過於頻繁，請稍候一分鐘。',429);
        attempts.set(address,limit);
        const input=await readJSON(req);
        assert(typeof input.password==='string' && input.password.length<=256,'密碼格式錯誤。');
        const password=await google.password();
        if(!equal(password,input.password)) limit.count++;
        assert(equal(password,input.password),'密碼不正確，請再試一次。',401);
        return reply(res,200,{token:tokens.sign({kind:'login',sid:randomUUID(),version:tokens.hash(password)},3600),mode:config.mode});
      }
      if(url.pathname==='/api/uploads' && req.method==='POST') {
        const auth=tokens.verify(bearer(req),'login'), input=await readJSON(req);
        assert(equal(auth.version,tokens.hash(await google.password())),'課堂密碼已更新，請重新登入。',401);
        assert(typeof input.id==='string' && /^[0-9a-f-]{36}$/i.test(input.id),'上傳識別碼格式錯誤。');
        const meta=validate(input);
        if(config.stateless) {
          const time=taipei(),job={id:input.id,owner:auth.sid,meta,time,name:filename(meta,time),fileId:await google.allocateId(),offset:0,state:'uploading',createdAt:Date.now()};
          job.session=await google.begin(job);
          return reply(res,200,{...view(job),uploadToken:tokens.seal({kind:'upload',job},86400)});
        }
        return await locks.run(input.id,async()=> {
          let job=store.state.jobs[input.id];
          if(job) {
            assert(job.owner===auth.sid && JSON.stringify(job.meta)===JSON.stringify(meta),'上傳識別碼已使用，請重新提交。',409);
          } else {
            assert(Object.values(store.state.jobs).filter(j=>j.owner===auth.sid && j.state!=='complete').length<10,'未完成上傳過多，請先完成現有上傳。',429);
            const time=taipei();
            job={id:input.id,owner:auth.sid,meta,time,name:filename(meta,time),fileId:await google.allocateId(),offset:0,state:'uploading',createdAt:Date.now()};
            store.state.jobs[job.id]=job; await store.save();
          }
          if(!job.session) { job.session=await google.begin(job); await store.save(); }
          return reply(res,200,{...view(job),uploadToken:tokens.sign({kind:'upload',id:job.id},86400)});
        });
      }
      const match=url.pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})$/i);
      if(match && ['GET','PUT'].includes(req.method)) {
        const auth=config.stateless ? tokens.open(bearer(req),'upload') : tokens.verify(bearer(req),'upload');
        const job=config.stateless ? auth.job : store.state.jobs[match[1]];
        assert(job && job.id===match[1] && (config.stateless || auth.id===match[1]),'無權存取此上傳。',403);
        if(req.method==='GET') return await locks.run(job.id,async()=> {
          await sync(job);
          reply(res,200,{...view(job),...(config.stateless && job.state!=='complete'?{uploadToken:tokens.seal({kind:'upload',job},86400)}:{})});
        });
        const release=await uploads.acquire(req,res);
        let buffer;
        try {
          buffer=await readBody(req,CHUNK_SIZE);
          return await locks.run(job.id,async()=> {
            const start=Number(req.headers['x-chunk-offset']);
            assert(req.headers['x-chunk-offset']!==undefined && Number.isInteger(start) && start>=0,'分塊位置格式錯誤。');
            if(job.state==='complete') return reply(res,200,view(job));
            assert(start===job.offset,'上傳進度已變更，請重試以同步進度。',409);
            assert(buffer.length>0 && start+buffer.length<=job.meta.size && (buffer.length===CHUNK_SIZE || start+buffer.length===job.meta.size),'分塊大小不正確。');
            if(start===0) assert(checkSignature(buffer,job.meta.ext),'檔案內容與照片／影片格式不符。');
            const result=await google.chunk(job,buffer,start);buffer=null;job.offset=result.offset;
            if(result.complete) await finish(job); else await store.save();
            reply(res,200,{...view(job),...(config.stateless && job.state!=='complete'?{uploadToken:tokens.seal({kind:'upload',job},86400)}:{})});
          });
        } finally { buffer=null;release(); }
      }
      const staticFiles={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/app.js':'app.js','/config.js':'config.js'};
      if(req.method==='GET' && Object.hasOwn(staticFiles,url.pathname)) {
        const file=staticFiles[url.pathname], ext=path.extname(file);
        res.writeHead(200,{'Content-Type':ext==='.html'?'text/html; charset=utf-8':ext==='.css'?'text/css; charset=utf-8':'text/javascript; charset=utf-8'});
        res.end(await readFile(path.join(publicDir,file)));return;
      }
      throw new AppError(404,'找不到此項目。');
    } catch(e) {
      if(!res.headersSent && (e.status===429 || !e.status || e.status===503)) res.setHeader('Retry-After','5');
      if(!res.headersSent) reply(res,e.status || 503,{error:e instanceof AppError ? e.message:'服務暫時無法完成操作，請稍後重試。'});
      else res.end();
    } finally { releaseControl?.(); }
  });
  server.requestTimeout=120_000;
  const repair=setInterval(async()=> {
    for(const [key,value] of attempts) if(value.until<Date.now()) attempts.delete(key);
    for(const job of Object.values(store.state.jobs)) {
      if(job.state==='recording') await locks.run(job.id,()=>finish(job)).catch(()=>{});
    }
  },30_000);repair.unref();
  server.on('close',()=>{clearInterval(repair);uploads.close();controls.close();attempts.clear();});
  return {server,store,google,uploads,controls};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const config=configFromEnv();
  const app=await createApp(config);
  if(config.mode==='google') await app.google.probe();
  app.server.listen(config.port,'0.0.0.0',()=>console.log(`Collect.Silomo listening on port ${config.port} (${config.mode})`));
}
