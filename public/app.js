/* All credentials stay in memory; opening/reloading the page requires a fresh login. */
const $=id=>document.getElementById(id);
const apiBase=(window.COLLECT_CONFIG?.apiBase || '').replace(/\/$/,'');
const state={token:null,mode:'google',classroom:null,seats:new Set(),file:null,job:null,payload:null,busy:false};
const segments=text=>Array.from(new Intl.Segmenter('zh-Hant',{granularity:'grapheme'}).segment(text));
function show(panel){for(const name of ['login','upload','success']) $(name+'-panel').hidden=name!==panel;window.scrollTo({top:0,behavior:'smooth'});}
function setMode(mode){state.mode=mode;$('mode-banner').hidden=mode!=='mock';}
async function apiOnce(route,{method='GET',body,token=state.token,headers={}}={}){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),115000);
  try{
    const response=await fetch(apiBase+route,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body && !(body instanceof Blob)?{'Content-Type':'application/json'}:{}),...headers},body:body instanceof Blob?body:body?JSON.stringify(body):undefined,signal:controller.signal,cache:'no-store'});
    const data=await response.json().catch(()=>{const error=new Error('服務啟動中，正在等待連線。');error.status=503;throw error;});
    if(!response.ok){const error=new Error(data.error || '操作失敗，請稍後重試。');error.status=response.status;throw error;}
    return data;
  }catch(e){if(e instanceof TypeError || e.name==='AbortError')throw new Error('連線暫時中斷或服務啟動中，請稍後重試。');throw e;}finally{clearTimeout(timer);}
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(route,options={}){
  const deadline=Date.now()+300000;let lastError,needsSync=false;
  for(let attempt=0;attempt<10 && Date.now()<deadline;attempt++){
    try{
      if(needsSync){
        const latest=await apiOnce(route,{token:options.token});
        options={...options,token:latest.uploadToken||options.token};
        if(latest.state==='complete'||latest.offset!==Number(options.headers['X-Chunk-Offset']))return latest;
        needsSync=false;
      }
      return await apiOnce(route,options);
    }catch(error){
      lastError=error;
      if(error.status && ![408,409,429,500,502,503,504].includes(error.status))throw error;
      if(options.method==='PUT')needsSync=true;
      const delay=Math.min(15000,2000*2**Math.min(attempt,3))+Math.random()*1500;
      const message='正在等待服務或排隊，請保持頁面開啟，系統會自動繼續。';
      if(route==='/api/login')$('login-button').textContent=message;
      else if(route.startsWith('/api/uploads')){$('progress-panel').hidden=false;$('progress-title').textContent=message;}
      await sleep(delay);
    }
  }
  throw lastError||new Error('等待時間較長，請稍後按繼續上傳。');
}
function renderSeats(){
  for(const button of $('seats').children){const selected=state.seats.has(Number(button.dataset.seat));button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));button.setAttribute('aria-disabled',String(!selected&&state.seats.size>=5));}
  $('seat-count').textContent=`已選 ${state.seats.size} / 5 位`;
}
for(let n=1;n<=4;n++){
  const b=document.createElement('button');b.type='button';b.className='choice';b.textContent=`${n}班`;b.setAttribute('aria-pressed','false');
  b.addEventListener('click',()=>{state.classroom=n;for(const c of $('classes').children){c.classList.toggle('selected',c===b);c.setAttribute('aria-pressed',String(c===b));}});$('classes').append(b);
}
for(let n=1;n<=28;n++){
  const b=document.createElement('button');b.type='button';b.className='choice';b.textContent=`${String(n).padStart(2,'0')}號`;b.dataset.seat=n;b.setAttribute('aria-pressed','false');
  b.addEventListener('click',()=>{if(state.seats.has(n))state.seats.delete(n);else if(state.seats.size<5)state.seats.add(n);else{$('seat-message').textContent='最多選5位，請先取消一個座號。';return;}$('seat-message').textContent='';renderSeats();});$('seats').append(b);
}
$('show-password').addEventListener('click',()=>{const show=$('password').type==='password';$('password').type=show?'text':'password';$('show-password').textContent=show?'隱藏':'顯示';$('show-password').setAttribute('aria-pressed',String(show));});
$('login-form').addEventListener('submit',async e=>{
  e.preventDefault();$('login-error').textContent='';$('login-button').disabled=true;$('login-button').textContent='正在核對密碼…';
  try{const result=await api('/api/login',{method:'POST',body:{password:$('password').value},token:null});state.token=result.token;setMode(result.mode);$('password').value='';if(!state.job){$('upload-button').hidden=false;$('upload-button').textContent='↑ 開始上傳到雲端';}show('upload');$('upload-title').tabIndex=-1;$('upload-title').focus();}
  catch(e){$('login-error').textContent=e.message;}finally{$('login-button').disabled=false;$('login-button').textContent='進入上傳頁面 →';}
});
function topicCount(){const count=segments($('topic').value.normalize('NFC').trim()).length;$('topic-count').textContent=`${count} / 10 字`;$('topic-count').classList.toggle('over',count>10);$('topic').setCustomValidity(count>10?'實驗主題最多10字。':'');}
$('topic').addEventListener('input',topicCount);
$('file').addEventListener('change',()=>{const file=$('file').files[0];state.file=file || null;$('file').setCustomValidity(file?.size>100000000?'檔案不可超過100MB。':file?.size===0?'不可上傳空檔案。':'');$('file-summary').textContent=file?`${file.name} · ${(file.size/1000000).toFixed(2)} MB`:'也可以從照片圖庫或相機選取';});
function busy(value){state.busy=value;$('details').disabled=value||Boolean(state.job);$('upload-button').disabled=value;$('retry-button').disabled=value;$('logout').disabled=value;$('reset-button').disabled=value;}
function progress(job){const percent=Math.floor(job.offset/job.size*100);$('progress-panel').hidden=false;$('progress').value=percent;$('progress-percent').textContent=`${percent}%`;$('progress-title').textContent=job.state==='recording'?'檔案已收到，正在完成繳交紀錄…':`作品上傳中 · ${(job.offset/1000000).toFixed(1)} / ${(job.size/1000000).toFixed(1)} MB`;}
function success(){
  $('receipt-group').textContent=`5年${state.payload.classroom}班 · ${[...state.payload.seats].sort((a,b)=>a-b).map(n=>String(n).padStart(2,'0')).join('、')}號`;
  $('receipt-topic').textContent=state.payload.topic;$('receipt-file').textContent=state.job.name;
  state.file=null;$('file').value='';state.job.uploadToken=null;
  $('success-title').textContent=state.mode==='mock'?'模擬上傳完成！':'作品已繳交！';
  $('success-description').textContent=state.mode==='mock'?'這是本機測試，檔案未送至 Google Drive。':'檔案已存入老師的雲端硬碟，並完成繳交紀錄。';
  show('success');$('success-title').tabIndex=-1;$('success-title').focus();
}
async function upload(){
  if(state.busy)return;busy(true);$('upload-error').textContent='';$('retry-button').hidden=true;$('reset-button').hidden=true;$('upload-button').textContent='正在上傳，請稍候…';
  try{
    if(!state.job){state.job=await api('/api/uploads',{method:'POST',body:state.payload});}
    else{Object.assign(state.job,await api(`/api/uploads/${state.job.id}`,{token:state.job.uploadToken}));}
    progress(state.job);
    while(state.job.state!=='complete'){
      if(state.job.offset===state.file.size){Object.assign(state.job,await api(`/api/uploads/${state.job.id}`,{token:state.job.uploadToken}));}
      else{const start=state.job.offset,chunk=state.file.slice(start,Math.min(start+state.job.chunkSize,state.file.size));const uploadToken=state.job.uploadToken;Object.assign(state.job,await api(`/api/uploads/${state.job.id}`,{method:'PUT',token:uploadToken,headers:{'Content-Type':'application/octet-stream','X-Chunk-Offset':String(start)},body:chunk}));state.job.uploadToken ||= uploadToken;}
      progress(state.job);
    }
    success();
  }catch(e){
    $('upload-error').textContent=e.message;$('upload-button').hidden=true;
    if(e.status===401 && !state.job){state.token=null;$('login-error').textContent=e.message;show('login');}
    else if(e.status===410 || e.status===400 || e.status===401){$('reset-button').hidden=false;}
    else{$('retry-button').hidden=false;}
  }finally{busy(false);}
}
$('upload-form').addEventListener('submit',e=>{
  e.preventDefault();if(state.busy)return;
  if(!state.classroom){$('upload-error').textContent='請先選擇班級。';$('classes').firstElementChild.focus();return;}
  if(!state.seats.size){$('upload-error').textContent='請至少選擇一個座號。';$('seats').firstElementChild.focus();return;}
  if(!$('topic').value.trim()){$('upload-error').textContent='請填寫實驗主題。';$('topic').focus();return;}
  if(!state.file){$('upload-error').textContent='請選擇照片或影片。';return;}
  state.payload={id:crypto.randomUUID(),grade:5,classroom:state.classroom,seats:[...state.seats],topic:$('topic').value.normalize('NFC').trim(),description:$('description').value.trim(),filename:state.file.name,size:state.file.size};
  upload();
});
$('retry-button').addEventListener('click',upload);
function reset(){state.job=null;state.payload=null;state.file=null;$('file').value='';$('file').setCustomValidity('');$('file-summary').textContent='也可以從照片圖庫或相機選取';$('progress-panel').hidden=true;$('upload-error').textContent='';$('upload-button').hidden=false;$('upload-button').textContent='↑ 開始上傳到雲端';$('retry-button').hidden=true;$('reset-button').hidden=true;busy(false);}
$('reset-button').addEventListener('click',()=>{reset();show('upload');});
$('another').addEventListener('click',()=>{reset();show('upload');});
function logout(){reset();state.token=null;state.classroom=null;state.seats.clear();renderSeats();for(const b of $('classes').children){b.classList.remove('selected');b.setAttribute('aria-pressed','false');}$('upload-form').reset();topicCount();$('login-error').textContent='';show('login');$('password').focus();}
$('logout').addEventListener('click',logout);$('finish').addEventListener('click',logout);
window.addEventListener('beforeunload',e=>{if(state.job && state.job.state!=='complete'){e.preventDefault();e.returnValue='';}});
if(location.hostname.endsWith('github.io')&&!apiBase){$('login-error').textContent='尚未設定後臺網址，請老師完成網站部署設定。';$('login-button').disabled=true;}
else api('/api/config',{token:null}).then(result=>setMode(result.mode)).catch(()=>{});
