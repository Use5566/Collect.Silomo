import { AppError } from './core.js';

// Waiting requests retain only socket buffers, never a complete file chunk.
export class Queue {
  constructor(limit=4, capacity=32, timeout=45000) {
    Object.assign(this,{limit,capacity,timeout,active:0,waiting:[],closed:false});
  }
  acquire(req,res) {
    req.pause();
    if(this.closed) return Promise.reject(new AppError(503,'服務正在重新啟動，將自動重試。'));
    if(this.waiting.length>=this.capacity) return Promise.reject(new AppError(429,'目前正在排隊，將自動重試。'));
    return new Promise((resolve,reject)=>{
      const item={resolve,reject};
      const cancel=()=>{const i=this.waiting.indexOf(item);if(i>=0)this.waiting.splice(i,1);item.cleanup();reject(new AppError(503,'等待逾時或連線中斷，將自動重試。'));};
      const timer=setTimeout(cancel,this.timeout);timer.unref();
      item.cleanup=()=>{clearTimeout(timer);req.off('aborted',cancel);res.off('close',cancel);};
      req.once('aborted',cancel);res.once('close',cancel);
      this.waiting.push(item);this.drain();
    });
  }
  drain(){
    while(!this.closed && this.active<this.limit && this.waiting.length){
      const item=this.waiting.shift();item.cleanup();this.active++;
      let released=false;
      item.resolve(()=>{if(released)return;released=true;this.active--;this.drain();});
    }
  }
  close(){this.closed=true;for(const item of this.waiting.splice(0)){item.cleanup();item.reject(new AppError(503,'服務正在重新啟動，將自動重試。'));}}
}
