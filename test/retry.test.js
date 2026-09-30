import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
test('分塊回應丟失後先同步進度，避免再次傳送已收到的資料',async()=>{
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('async function apiOnce'),source.indexOf('function renderSeats'));
  const calls=[];const context=vm.createContext({state:{token:'login'},apiBase:'',Blob,AbortController,TypeError,Math,Date,
    setTimeout:(fn,ms)=>ms===115000?0:setTimeout(fn,0),clearTimeout,
    $:()=>({}),fetch:async(url,options)=>{calls.push(options.method);if(options.method==='PUT')throw new TypeError('Lost response');return {ok:true,json:async()=>({offset:2097152,state:'uploading',uploadToken:'renewed'})};}});
  vm.runInContext(code,context);
  const result=await vm.runInContext("api('/api/uploads/test',{method:'PUT',token:'old',headers:{'X-Chunk-Offset':'0'},body:new Blob(['data'])})",context);
  assert.equal(result.offset,2097152);assert.deepEqual(calls,['PUT','GET']);
});
