import { writeFile } from 'node:fs/promises';
const url=new URL(process.env.COLLECT_API_BASE);
if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/')throw new Error('COLLECT_API_BASE 必須是無路徑的 HTTPS 後臺網址。');
await writeFile('public/config.js',`window.COLLECT_CONFIG = ${JSON.stringify({apiBase:url.origin})};\n`);
