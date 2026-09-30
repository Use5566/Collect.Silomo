import { createHmac, timingSafeEqual, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export const MAX_SIZE = 100_000_000;
export const CHUNK_SIZE = 4 * 1024 * 1024;
export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const assert = (ok, message, status = 400) => { if (!ok) throw new AppError(status, message); };
export const formats = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm'
};
export const countChars = text => [...new Intl.Segmenter('zh-Hant', { granularity: 'grapheme' }).segment(text)].length;
export function validate(input) {
  assert(input && typeof input === 'object', '資料格式錯誤。');
  assert(input.grade === 5 && Number.isInteger(input.classroom) && input.classroom >= 1 && input.classroom <= 4, '請選擇5年級及1～4班。');
  assert(Array.isArray(input.seats) && input.seats.length >= 1 && input.seats.length <= 5 && new Set(input.seats).size === input.seats.length && input.seats.every(n => Number.isInteger(n) && n >= 1 && n <= 28), '座號須為1～28號，至少1位、最多5位，且不可重複。');
  assert(typeof input.topic === 'string', '請填寫實驗主題。');
  const topic = input.topic.normalize('NFC').trim();
  assert(topic && countChars(topic) <= 10 && !/[\p{Cc}\p{Cf}]/u.test(topic), '實驗主題必填、最多10字，且不可包含控制字元。');
  assert(input.description === undefined || typeof input.description === 'string', '說明格式錯誤。');
  const description = (input.description || '').trim();
  assert(description.length <= 5000, '說明過長，請縮短至5000字元內。');
  assert(typeof input.filename === 'string', '請選擇檔案。');
  const ext = input.filename.split('.').pop().toLowerCase();
  assert(Object.hasOwn(formats, ext), '請選擇支援的照片或影片格式。');
  assert(Number.isInteger(input.size) && input.size > 0 && input.size <= MAX_SIZE, '檔案須大於0 bytes，且不可超過100MB。');
  return { grade: 5, classroom: input.classroom, seats: [...input.seats].sort((a,b) => a-b), topic, description, ext, mime: formats[ext], size: input.size };
}
export function taipei(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(date).map(p => [p.type,p.value]));
  return { stamp: `${p.year}${p.month}${p.day}_${p.hour}${p.minute}`, display: `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}:${p.second}` };
}
export function filename(meta, time) {
  const safe = meta.topic.replace(/[<>:"/\\|?*]/g, '＿').replace(/[. ]+$/g, '') || '未命名';
  return `${time.stamp}_50${meta.classroom}_${meta.seats.map(s => String(s).padStart(2,'0')).join('.')}_${safe}.${meta.ext}`;
}
export function checkSignature(buffer, ext) {
  const hex = buffer.subarray(0, 12).toString('hex');
  const ascii = buffer.subarray(0, 64).toString('latin1');
  const image = { jpg: hex.startsWith('ffd8ff'), jpeg: hex.startsWith('ffd8ff'), png: hex.startsWith('89504e470d0a1a0a'), gif: /^GIF8[79]a/.test(ascii), webp: ascii.startsWith('RIFF') && ascii.slice(8,12) === 'WEBP' };
  if (Object.hasOwn(image, ext)) return image[ext];
  if (ext === 'webm') return hex.startsWith('1a45dfa3');
  if (ext === 'heic' || ext === 'heif') return ascii.slice(4,8) === 'ftyp' && /heic|heix|hevc|hevx|mif1|msf1/.test(ascii.slice(8));
  return ascii.slice(4,8) === 'ftyp' || (ext === 'mov' && /moov|mdat|wide/.test(ascii.slice(4,8)));
}
export function equal(a,b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x,y);
}
export class Tokens {
  constructor(secret) { this.secret = secret; }
  hash(value) { return createHmac('sha256', this.secret).update(value).digest('base64url'); }
  sign(data, seconds) {
    const body = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + seconds * 1000 })).toString('base64url');
    return `${body}.${this.hash(body)}`;
  }
  verify(token, kind) {
    try {
      const [body, mac, extra] = String(token).split('.');
      assert(!extra && equal(this.hash(body), mac), '', 401);
      const data = JSON.parse(Buffer.from(body,'base64url'));
      assert(data.kind === kind && data.exp > Date.now(), '', 401);
      return data;
    } catch { throw new AppError(401, '驗證已失效，請重新登入。'); }
  }
  key() { return createHmac('sha256',this.secret).update('collect-silomo-upload-token').digest(); }
  seal(data, seconds) {
    const iv=Buffer.from(randomUUID().replaceAll('-','').slice(0,24),'hex');
    const cipher=createCipheriv('aes-256-gcm',this.key(),iv);
    const encrypted=Buffer.concat([cipher.update(JSON.stringify({...data,exp:Date.now()+seconds*1000}),'utf8'),cipher.final()]);
    return `${iv.toString('base64url')}.${encrypted.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  }
  open(token, kind) {
    try {
      const [iv,data,tag,extra]=String(token).split('.');assert(!extra,'',401);
      const decipher=createDecipheriv('aes-256-gcm',this.key(),Buffer.from(iv,'base64url'));
      decipher.setAuthTag(Buffer.from(tag,'base64url'));
      const value=JSON.parse(Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]));
      assert(value.kind===kind && value.exp>Date.now(),'',401);return value;
    } catch { throw new AppError(401,'驗證已失效，請重新登入。'); }
  }
}
export class Store {
  constructor(dir) { this.dir = dir; this.state = { jobs: {}, nextRow: null }; this.queue = Promise.resolve(); }
  async open() {
    await mkdir(this.dir, { recursive:true });
    try { this.state = JSON.parse(await readFile(path.join(this.dir,'state.json'),'utf8')); }
    catch(e) { if (e.code !== 'ENOENT') throw e; }
  }
  async save() {
    const snapshot = JSON.stringify(this.state);
    const action = this.queue.then(async () => {
      const tmp = path.join(this.dir, `state-${randomUUID()}.tmp`);
      await writeFile(tmp, snapshot, { mode:0o600 });
      await rename(tmp, path.join(this.dir,'state.json'));
    });
    this.queue = action.catch(() => {});
    await action;
  }
}
export class Locks {
  constructor() { this.pending = new Map(); }
  async run(key, fn) {
    const previous = this.pending.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this.pending.set(key,current);
    try { return await current; } finally { if (this.pending.get(key) === current) this.pending.delete(key); }
  }
}
