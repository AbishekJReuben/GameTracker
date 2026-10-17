// Compile and execute the shipping RemoteRotationPolicy, without a phone or APK.
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
const directory = mkdtempSync(join(tmpdir(),'gametracker-rotation-test-'));
const suffix = process.platform === 'win32' ? '.exe' : '';
const jdk = [process.env.JAVA_HOME,'C:/Program Files/Android/Android Studio/jbr'].find(p=>p && existsSync(join(p,'bin',`javac${suffix}`)));
const run = (name,args) => {
  const result = spawnSync(jdk ? join(jdk,'bin',name + suffix) : name,args,{stdio:'inherit'});
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${name}: ${result.status}`);
};
try {
  for (const [folder,file] of [['android-templates','RemoteRotationPolicy.java'],['android-tests','RemoteRotationPolicyTest.java']]) {
    writeFileSync(join(directory,file),readFileSync(new URL(`./${folder}/${file}`,import.meta.url),'utf8').replaceAll('__PACKAGE__','rotationcheck'));
  }
  run('javac',['-d',directory,join(directory,'RemoteRotationPolicy.java'),join(directory,'RemoteRotationPolicyTest.java')]);
  run('java',['-cp',directory,'rotationcheck.RemoteRotationPolicyTest']);
} finally {
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Refusing cleanup outside temporary directory');
  rmSync(directory,{recursive:true,force:true});
}
