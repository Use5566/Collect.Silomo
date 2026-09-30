import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, filename, taipei, checkSignature, Tokens, countChars } from '../server/core.js';
import { configFromEnv } from '../server/config.js';
const valid={grade:5,classroom:1,seats:[22,3,1,17],topic:'光的折射',description:'',filename:'IMG_0001.MOV',size:100000000};
test('臺灣時間、自動命名、排序補零及副檔名',()=>{
  const meta=validate(valid);assert.equal(filename(meta,taipei(new Date('2026-09-29T07:20:00Z'))),'20260929_1520_501_01.03.17.22_光的折射.mov');
});
test('100MB 精確邊界與1～5名組員',()=>{
  assert.equal(validate({...valid,seats:[1,2,3,4,5]}).size,100000000);
  for(const bad of [{size:100000001},{size:0},{size:-1},{seats:[]},{seats:[1,2,3,4,5,6]},{seats:[1,1]},{seats:[29]},{seats:[0]},{classroom:5},{grade:6},{filename:'x.html'}])assert.throws(()=>validate({...valid,...bad}));
});
test('主題 Unicode 字數、空白、控制字元與檔名清理',()=>{
  assert.equal(countChars('光'.repeat(10)),10);assert.equal(validate({...valid,topic:'光'.repeat(10)}).topic.length,10);
  assert.throws(()=>validate({...valid,topic:'光'.repeat(11)}));assert.throws(()=>validate({...valid,topic:'   '}));assert.throws(()=>validate({...valid,topic:'光\n影'}));
  assert.match(filename(validate({...valid,topic:'光/影'}),taipei()),/光＿影.mov$/);
});
test('檔案標頭檢查拒絕偽裝 HTML',()=>{
  assert.equal(checkSignature(Buffer.from('<html>not an image</html>'),'png'),false);
  assert.equal(checkSignature(Buffer.from('89504e470d0a1a0a','hex'),'png'),true);
  assert.equal(checkSignature(Buffer.from('000000186674797068656963000000006d696631','hex'),'heic'),true);
});
test('憑證防竄改、用途隔離及到期',()=>{
  const t=new Tokens('secret');const token=t.sign({kind:'login',sid:'x'},60);assert.equal(t.verify(token,'login').sid,'x');
  assert.throws(()=>t.verify(token+'x','login'));assert.throws(()=>t.verify(token,'upload'));assert.throws(()=>t.verify(t.sign({kind:'login'},-1),'login'));
});
test('加密上傳憑證不洩漏工作內容且可驗證',()=>{
  const t=new Tokens('secret');const token=t.seal({kind:'upload',job:{session:'sensitive-upload-url'}},60);
  assert.equal(token.includes('sensitive-upload-url'),false);assert.equal(t.open(token,'upload').job.session,'sensitive-upload-url');
  const parts=token.split('.');parts[1]=(parts[1][0]==='A'?'B':'A')+parts[1].slice(1);
  assert.throws(()=>t.open(parts.join('.'),'upload'));assert.throws(()=>t.open(token,'login'));
});
test('Render 僅從 Secret File 讀取 Google 資源 ID',()=>{
  const config=configFromEnv({RENDER:'true',SESSION_SECRET:'a'.repeat(64)},()=>JSON.stringify({driveFolderId:'folder-secret',spreadsheetId:'sheet-secret'}));
  assert.equal(config.mode,'google');assert.equal(config.stateless,true);assert.equal(config.folderId,'folder-secret');assert.equal(config.sheetId,'sheet-secret');
  assert.equal(config.credentials,'/etc/secrets/google-service-account.json');
});
