// Local synthetic traffic only. Does not contact Google or Render.
import http from 'node:http';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/index.js';
import {configFromEnv} from '../server/config.js';
import {MockGoogle} from '../server/google.js';
import {CHUNK_SIZE} from '../server/core.js';
if(process.argv[2]==='server'){
  const google=new MockGoogle('load-test');let peakActive=0,peakWaiting=0,peakRss=0;
  const original=google.chunk.bind(google);
  google.chunk=async(job,buffer,start)=>{
    const response=await fetch(process.argv[3],{method:'POST',body:buffer,signal:AbortSignal.timeout(10000)});
    await response.arrayBuffer();
    return original(job,buffer,start);
  };
  const config=configFromEnv({MODE:'mock',SESSION_SECRET:'load-test-secret'});config.stateless=true;
  const app=await createApp(config,google);
  const sample=()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);peakActive=Math.max(peakActive,app.uploads.active);peakWaiting=Math.max(peakWaiting,app.uploads.waiting.length);};
  const timer=setInterval(sample,5);
  app.server.listen(0,'127.0.0.1',()=>process.send({port:app.server.address().port}));
  process.once('message',()=>{sample();clearInterval(timer);process.send({peakRssMiB:Math.round(peakRss/1024/1024),peakActive,peakWaiting,remainingActive:app.uploads.active,remainingWaiting:app.uploads.waiting.length,records:google.records.size});app.server.close();app.server.closeAllConnections();process.disconnect();});
}else{
  const sink=http.createServer(async(req,res)=>{for await(const part of req)void part;setTimeout(()=>res.end('ok'),30);});
  sink.listen(0,'127.0.0.1');await once(sink,'listening');
  const child=fork(new URL(import.meta.url),['server',`http://127.0.0.1:${sink.address().port}`],{stdio:['ignore','inherit','inherit','ipc']});
  try{
    const [{port}]=await once(child,'message');const base=`http://127.0.0.1:${port}`,startTime=Date.now();
    async function call(route,{method='GET',token,body,headers={}}={}){
      const r=await fetch(base+route,{method,headers:{...headers,...(token?{Authorization:`Bearer ${token}`}:{})},body:Buffer.isBuffer(body)?body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});
      const data=await r.json();if(!r.ok)throw new Error(`HTTP ${r.status}: ${data.error}`);return data;
    }
    await Promise.all(Array.from({length:16},async()=>{
      const login=await call('/api/login',{method:'POST',body:{password:'load-test'}});
      let job=await call('/api/uploads',{method:'POST',token:login.token,body:{id:randomUUID(),grade:5,classroom:1,seats:[1],topic:'負載測試',filename:'test.mp4',size:50000000}});
      const buffer=Buffer.alloc(CHUNK_SIZE);buffer.write('ftyp',4);
      while(job.state!=='complete'){
        const token=job.uploadToken;
        job=await call(`/api/uploads/${job.id}`,{method:'PUT',token,headers:{'X-Chunk-Offset':String(job.offset)},body:buffer.subarray(0,Math.min(CHUNK_SIZE,job.size-job.offset))});
        job.uploadToken ||= token;
      }
    }));
    const report=once(child,'message');child.send('report');const [metrics]=await report;
    console.log(JSON.stringify({groups:16,bytesPerGroup:50000000,totalBytes:800000000,seconds:Math.round((Date.now()-startTime)/100)/10,...metrics},null,2));
    if(metrics.records!==16||metrics.peakActive>4||metrics.remainingActive||metrics.remainingWaiting)throw new Error('Load test failed');
  }finally{child.kill();sink.close();sink.closeAllConnections();}
}
