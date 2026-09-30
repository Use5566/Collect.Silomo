import { readFile } from 'node:fs/promises';
import { createSign, randomUUID } from 'node:crypto';
import { AppError, assert } from './core.js';

export class Google {
  constructor(config) { this.config = config; this.access = null; }
  async token() {
    if (this.access && this.access.expires > Date.now()) return this.access.value;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = this.issueToken();
    try { return await this.tokenPromise; } finally { this.tokenPromise = null; }
  }
  async issueToken() {
    const key = JSON.parse(await readFile(this.config.credentials, 'utf8'));
    const now = Math.floor(Date.now()/1000);
    const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
    const body = `${encode({ alg:'RS256',typ:'JWT' })}.${encode({ iss:key.client_email, scope:'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets', aud:'https://oauth2.googleapis.com/token', iat:now, exp:now+3600 })}`;
    const signature = createSign('RSA-SHA256').update(body).sign(key.private_key,'base64url');
    const response = await fetch('https://oauth2.googleapis.com/token', { method:'POST', body:new URLSearchParams({ grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion:`${body}.${signature}` }), signal:AbortSignal.timeout(30_000) });
    if (!response.ok) throw new AppError(503,'Google 授權失敗，請老師確認服務帳戶設定。');
    const result = await response.json();
    this.access = { value:result.access_token, expires:Date.now()+(result.expires_in-120)*1000 };
    return this.access.value;
  }
  async request(url, options = {}) {
    const response = await fetch(url, { ...options, redirect:'manual', headers:{ ...options.headers, Authorization:`Bearer ${await this.token()}` }, signal:AbortSignal.timeout(90_000) });
    if (response.status === 401) this.access = null;
    return response;
  }
  async json(url, options = {}) {
    const response = await this.request(url,options);
    if (!response.ok) {
      await response.body?.cancel();
      // Only upstream status is retained. Never log tokens, passwords or private response bodies.
      throw new AppError(503,`Google 服務暫時無法完成操作（${response.status}），請稍後重試。`);
    }
    return response.json();
  }
  sheetUrl(range) { return `https://sheets.googleapis.com/v4/spreadsheets/${this.config.sheetId}/values/${encodeURIComponent(range)}`; }
  logRange(cells) { return `'${this.config.logSheet.replaceAll("'","''")}'!${cells}`; }
  async password() {
    const result = await this.json(this.sheetUrl(this.config.passwordRange));
    const value = String(result.values?.[0]?.[0] ?? '');
    assert(value.length > 0, '老師尚未設定課堂密碼，請稍後再試。',503);
    return value;
  }
  async probe() {
    const folder = await this.json(`https://www.googleapis.com/drive/v3/files/${this.config.folderId}?supportsAllDrives=true&fields=id,name,mimeType,driveId,capabilities(canAddChildren)`);
    assert(folder.mimeType === 'application/vnd.google-apps.folder' && folder.driveId, '指定位置不是共用雲端硬碟資料夾，請確認位置。',503);
    assert(folder.capabilities?.canAddChildren, '服務帳戶沒有目標資料夾的新增權限。',503);
    const rows = await this.rows();
    assert(JSON.stringify(rows[0]?.slice(0,5)) === JSON.stringify(['時間','班級','座號','主題','說明']), '工作表1 的 A1:E1 必須依序為：時間、班級、座號、主題、說明。',503);
    await this.password();
    return { folderName:folder.name, sharedDrive:true, rowCount:rows.length, passwordConfigured:true };
  }
  async rows() { return (await this.json(this.sheetUrl(this.logRange('A:E')))).values || []; }
  async nextRow() { return Math.max(2, (await this.rows()).length+1); }
  async writeRow(row, values) {
    const url = this.sheetUrl(this.logRange(`A${row}:E${row}`));
    const existing = (await this.json(url)).values?.[0] || [];
    const normalize = v => Array.from({length:5}, (_,i) => String(v[i] ?? ''));
    if (existing.some(x => String(x) !== '')) {
      assert(JSON.stringify(normalize(existing)) === JSON.stringify(normalize(values)), '紀錄列已被其他資料占用，請老師檢查試算表後重試。',409);
      return;
    }
    await this.json(`${url}?valueInputOption=RAW`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ values:[values] }) });
  }
  async sheetInfo() {
    const result=await this.json(`https://sheets.googleapis.com/v4/spreadsheets/${this.config.sheetId}?fields=sheets(properties(sheetId,title,gridProperties(rowCount)))`);
    const sheet=result.sheets?.find(s=>s.properties?.title===this.config.logSheet);
    assert(sheet,'找不到工作表1。',503);return sheet.properties;
  }
  async findRecord(uploadId) {
    const result=await this.json(`https://sheets.googleapis.com/v4/spreadsheets/${this.config.sheetId}/developerMetadata:search`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataFilters:[{developerMetadataLookup:{metadataKey:'collectUploadId',metadataValue:uploadId,locationType:'ROW'}}]})});
    return result.matchedDeveloperMetadata?.[0]?.developerMetadata || null;
  }
  async hasRecord(uploadId) { return Boolean(await this.findRecord(uploadId)); }
  async writeRecord(job) {
    if(await this.hasRecord(job.id)) return;
    const rows=await this.rows(), info=await this.sheetInfo(), row=Math.max(1,rows.length);
    const values=[job.time.display,`50${job.meta.classroom}`,job.meta.seats.map(n=>String(n).padStart(2,'0')).join('.'),job.meta.topic,job.meta.description];
    const requests=[];
    if(row>=info.gridProperties.rowCount) requests.push({appendDimension:{sheetId:info.sheetId,dimension:'ROWS',length:row-info.gridProperties.rowCount+1}});
    requests.push({updateCells:{start:{sheetId:info.sheetId,rowIndex:row,columnIndex:0},rows:[{values:values.map(v=>({userEnteredValue:{stringValue:String(v)}}))}],fields:'userEnteredValue'}});
    requests.push({createDeveloperMetadata:{developerMetadata:{metadataKey:'collectUploadId',metadataValue:job.id,visibility:'DOCUMENT',location:{dimensionRange:{sheetId:info.sheetId,dimension:'ROWS',startIndex:row,endIndex:row+1}}}}});
    await this.json(`https://sheets.googleapis.com/v4/spreadsheets/${this.config.sheetId}:batchUpdate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requests})});
  }
  async removeTestRecord(job) {
    const metadata=await this.findRecord(job.id);assert(metadata,'找不到測試紀錄。',404);
    const row=metadata.location?.dimensionRange?.startIndex;assert(Number.isInteger(row),'測試紀錄位置不正確。',409);
    const values=[job.time.display,`50${job.meta.classroom}`,job.meta.seats.map(n=>String(n).padStart(2,'0')).join('.'),job.meta.topic,job.meta.description];
    const range=this.logRange(`A${row+1}:E${row+1}`),current=(await this.json(this.sheetUrl(range))).values?.[0] || [];
    assert(JSON.stringify(current)===JSON.stringify(values),'測試列內容已變更，停止自動清理。',409);
    await this.json(`${this.sheetUrl(range)}:clear`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    await this.json(`https://sheets.googleapis.com/v4/spreadsheets/${this.config.sheetId}:batchUpdate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requests:[{deleteDeveloperMetadata:{dataFilter:{developerMetadataLookup:{metadataId:metadata.metadataId}}}}]})});
  }
  async allocateId() { return (await this.json('https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files')).ids[0]; }
  async begin(job) {
    const response = await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,size,name', { method:'POST', headers:{ 'Content-Type':'application/json', 'X-Upload-Content-Type':job.meta.mime, 'X-Upload-Content-Length':String(job.meta.size) }, body:JSON.stringify({ id:job.fileId, name:job.name, parents:[this.config.folderId], mimeType:job.meta.mime, appProperties:{ collectUploadId:job.id } }) });
    if (!response.ok || !response.headers.get('location')) throw new AppError(503,`無法建立 Google 上傳工作（${response.status}）。`);
    return response.headers.get('location');
  }
  async completed(job) {
    const response = await this.request(`https://www.googleapis.com/drive/v3/files/${job.fileId}?supportsAllDrives=true&fields=id,size,name,trashed`);
    if (response.status === 404) return false;
    if (!response.ok) throw new AppError(503,'無法確認雲端檔案狀態，請重試。');
    const file = await response.json();
    assert(!file.trashed && Number(file.size) === job.meta.size, '雲端檔案大小不符或已被移除，請老師檢查。',409);
    return true;
  }
  async parseUpload(response, job) {
    if (response.status === 308) {
      const range = response.headers.get('range');
      await response.body?.cancel();
      return { offset:range ? Number(range.split('-').pop())+1 : 0, complete:false };
    }
    if (response.ok) {
      const result = await response.json();
      assert(result.id === job.fileId && Number(result.size) === job.meta.size, '上傳結果驗證失敗。',503);
      return { offset:job.meta.size, complete:true };
    }
    if (response.status === 404 || response.status === 410) throw new AppError(410,'上傳工作已過期，請重新選擇檔案並提交。');
    throw new AppError(503,`上傳暫時中斷（${response.status}），請按重試繼續。`);
  }
  async status(job) {
    if (await this.completed(job)) return { offset:job.meta.size, complete:true };
    return this.parseUpload(await this.request(job.session, { method:'PUT', headers:{'Content-Range':`bytes */${job.meta.size}`, 'Content-Length':'0'} }), job);
  }
  async chunk(job, buffer, start) {
    return this.parseUpload(await this.request(job.session, { method:'PUT', headers:{'Content-Type':job.meta.mime, 'Content-Range':`bytes ${start}-${start+buffer.length-1}/${job.meta.size}`}, body:buffer }), job);
  }
}

export class MockGoogle {
  constructor(password = '1234') { this.currentPassword=password; this.files=new Map(); this.records=new Map(); this.failWrites=false; }
  async password() { assert(this.currentPassword, '尚未設定密碼。',503); return this.currentPassword; }
  async probe() { return { folderName:'本機模擬資料夾', sharedDrive:true, passwordConfigured:true }; }
  async nextRow() { return this.records.size+2; }
  async allocateId() { return randomUUID(); }
  async begin(job) { this.files.set(job.fileId,{offset:0,size:job.meta.size}); return 'mock-session'; }
  async status(job) { const f=this.files.get(job.fileId); assert(f,'模擬服務已重啟，請重新提交。',410); return {offset:f.offset,complete:f.offset===f.size}; }
  async chunk(job, buffer, start) { const f=this.files.get(job.fileId); assert(f && f.offset===start,'上傳位置不符。',409); f.offset+=buffer.length; return this.status(job); }
  async writeRow(row, values) { if(this.failWrites) throw new AppError(503,'模擬紀錄暫時失敗。'); this.records.set(row,values); }
  async writeRecord(job) { if(this.failWrites) throw new AppError(503,'模擬紀錄暫時失敗。'); if(!this.records.has(job.id)) this.records.set(job.id,[job.time.display,`50${job.meta.classroom}`,job.meta.seats.map(n=>String(n).padStart(2,'0')).join('.'),job.meta.topic,job.meta.description]); }
}
