import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';import {spawnSync} from 'node:child_process';
const directory=mkdtempSync(join(tmpdir(),'gametracker-frame-proof-')),suffix=process.platform==='win32'?'.exe':'';
const jdk=[process.env.JAVA_HOME,'C:/Program Files/Android/Android Studio/jbr'].find(p=>p&&existsSync(join(p,'bin',`javac${suffix}`)));
const run=(tool,args)=>{const r=spawnSync(jdk?join(jdk,'bin',tool+suffix):tool,args,{stdio:'inherit'});if(r.error||r.status!==0)throw r.error??new Error(`${tool}: ${r.status}`);};
try{for(const [folder,file]of [['android-templates','RenderedFrameProof.java'],['android-tests','RenderedFrameProofTest.java'],['android-templates','TransitionOwnership.java'],['android-tests','TransitionOwnershipTest.java']])writeFileSync(join(directory,file),readFileSync(new URL(`./${folder}/${file}`,import.meta.url),'utf8').replaceAll('__PACKAGE__','framecheck'));
  run('javac',['-d',directory,join(directory,'RenderedFrameProof.java'),join(directory,'RenderedFrameProofTest.java'),join(directory,'TransitionOwnership.java'),join(directory,'TransitionOwnershipTest.java')]);run('java',['-cp',directory,'framecheck.RenderedFrameProofTest']);run('java',['-cp',directory,'framecheck.TransitionOwnershipTest']);
}finally{if(!resolve(directory).startsWith(resolve(tmpdir())+sep))throw new Error('Unsafe temporary path');rmSync(directory,{recursive:true,force:true});}
