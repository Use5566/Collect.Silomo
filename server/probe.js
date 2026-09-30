import { Google } from './google.js';
import { configFromEnv } from './config.js';
try {
  const google = new Google(configFromEnv());
  console.log(JSON.stringify(await google.probe(),null,2));
} catch(e) { console.error(e.message); process.exitCode=1; }
