import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Queue} from '../server/queue.js';
const pair=()=>{const req=new EventEmitter();req.pause=()=>{};return [req,new EventEmitter()];};
test('排隊遵守 FIFO、名額上限、斷線取消與重複釋放',async()=>{
  const q=new Queue(1,2), a=pair(), b=pair(), c=pair();
  const release=await q.acquire(...a), order=[];
  const pending=q.acquire(...b).then(r=>{order.push('b');return r;});
  const cancelled=q.acquire(...c);const rejected=assert.rejects(cancelled,{status:503});
  await assert.rejects(q.acquire(...pair()),{status:429});
  c[1].emit('close');await rejected;release();release();
  const releaseB=await pending;assert.deepEqual(order,['b']);assert.equal(q.active,1);
  releaseB();assert.equal(q.active,0);assert.equal(q.waiting.length,0);assert.equal(c[1].listenerCount('close'),0);
});
test('等待逾時及關閉服務清空佇列',async()=>{
  const q=new Queue(1,3,20);const release=await q.acquire(...pair());
  const wait=q.acquire(...pair());const timer=setTimeout(()=>{},100);
  await assert.rejects(wait,{status:503});clearTimeout(timer);assert.equal(q.waiting.length,0);
  const next=q.acquire(...pair());q.close();await assert.rejects(next,{status:503});release();assert.equal(q.active,0);
});
