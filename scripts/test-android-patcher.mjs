// Exercise the actual patcher against a fresh manifest in an isolated tree.
// The production/generated project and connected phone are not touched.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = resolve(fileURLToPath(new URL('..',import.meta.url)));
const temp = mkdtempSync(join(tmpdir(),'gametracker-patcher-test-'));
const target = join(temp,'companion','src-tauri','gen','android');
try {
  mkdirSync(join(temp,'scripts'),{recursive:true});
  cpSync(join(root,'scripts','patch-android.mjs'),join(temp,'scripts','patch-android.mjs'));
  cpSync(join(root,'scripts','android-templates'),join(temp,'scripts','android-templates'),{recursive:true});
  mkdirSync(join(temp,'companion','src-tauri'),{recursive:true});
  cpSync(join(root,'companion','src-tauri','tauri.conf.json'),join(temp,'companion','src-tauri','tauri.conf.json'));
  cpSync(join(root,'companion','src-tauri','gen','android'),target,{recursive:true,filter:p=>!/[\\/](?:build|\.gradle|\.idea)(?:[\\/]|$)/.test(p)});
  const manifest = `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <uses-permission android:name="android.permission.INTERNET" />\n    <application android:usesCleartextTraffic="false" android:label="Tracker">\n        <activity android:name=".MainActivity" android:exported="true">\n            <intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter>\n        </activity>\n    </application>\n</manifest>\n`;
  writeFileSync(join(target,'app','src','main','AndroidManifest.xml'),manifest);
  const run = () => {
    const result=spawnSync(process.execPath,[join(temp,'scripts','patch-android.mjs')],{encoding:'utf8'});
    if(result.status!==0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const hashes = () => {
    const result = new Map();
    function visit(path) { for(const entry of readdirSync(path,{withFileTypes:true})) {
      const p=join(path,entry.name); if(entry.isDirectory()) visit(p);
      else result.set(relative(target,p),createHash('sha256').update(readFileSync(p)).digest('hex'));
    } }
    visit(target); return result;
  };
  const firstLog=run(),first=hashes(); const secondLog=run(),second=hashes();
  const delta=[...new Set([...first.keys(),...second.keys()])].filter(p=>first.get(p)!==second.get(p));
  if(delta.length) throw new Error('Second patch run changed: '+delta.join(', '));
  const generated=readFileSync(join(target,'app','src','main','AndroidManifest.xml'),'utf8');
  for(const entry of ['MainActivity','ClipboardService','ClipboardBootReceiver','VoiceService','NotesTileService','NetworkSettingsShortcut','NetworkToggleShortcut','VoLteToggleShortcut']) {
    const count=(generated.match(new RegExp(`android:name="\\.${entry}"`,'g'))??[]).length;
    if(count!==1) throw new Error(`${entry} appears ${count} times`);
  }
  console.log(JSON.stringify({files:second.size,changesOnSecondRun:delta.length,firstLog,secondLog,scope:'isolated generated tree; fresh manifest fixture, production patcher and shipping templates'}));
} finally {
  if(!resolve(temp).startsWith(resolve(tmpdir())+sep)) throw new Error('Refusing cleanup outside temp directory');
  rmSync(temp,{recursive:true,force:true});
}
