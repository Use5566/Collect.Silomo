import path from 'node:path';
import { readFileSync } from 'node:fs';
export function configFromEnv(env = process.env, readSecret = readFileSync) {
  const render = Boolean(env.RENDER);
  let privateConfig = {};
  if (render) {
    try { privateConfig = JSON.parse(readSecret('/etc/secrets/collect-config.json','utf8')); }
    catch { throw new Error('缺少或無法讀取 /etc/secrets/collect-config.json'); }
  }
  const config = {
    mode:render ? 'google' : (env.MODE || 'mock'), port:Number(env.PORT || 3000),
    secret:env.SESSION_SECRET || 'local-development-only-change-before-deploy',
    origins:render ? ['https://use5566.github.io','https://collect-silomo.onrender.com'] : (env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000').split(',').map(s=>s.trim()).filter(Boolean),
    dataDir:path.resolve(env.DATA_DIR || './data'),
    credentials:render ? '/etc/secrets/google-service-account.json' : env.GOOGLE_APPLICATION_CREDENTIALS,
    folderId:render ? privateConfig.driveFolderId : env.DRIVE_FOLDER_ID,
    sheetId:render ? privateConfig.spreadsheetId : env.SPREADSHEET_ID,
    logSheet:'工作表1', passwordRange:"'工作表2'!A2",
    mockPassword:env.MOCK_PASSWORD || '1234', trustProxy:render || env.TRUST_PROXY === '1', stateless:render
  };
  if (!['mock','google'].includes(config.mode)) throw new Error('MODE 必須是 mock 或 google');
  if (config.mode === 'google' && (!config.credentials || !config.folderId || !config.sheetId || config.secret.length < 32 || config.secret.includes('local-development'))) throw new Error('正式模式需要兩個 Secret Files 與至少32字元的 SESSION_SECRET');
  return config;
}
