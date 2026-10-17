import fs from 'node:fs';
const path=new URL('requirements.json',import.meta.url),doc=JSON.parse(fs.readFileSync(path,'utf8'));
const evidence=['checkpoint-4-capture-engine.md','evidence/stage-g-combined-v8.json','evidence/stage-g-combined-v8-decode.json','evidence/stage-g-native-model-tests-v3.log'];
for(const r of doc.requirements){if(r.id!=='13'&&!r.id.startsWith('13.'))continue;r.evidence=[...new Set([...r.evidence,...evidence])];
  if(['13.3','13.4','13.5','13.6','13.10','13.11','13.13','13.14','13.15','13.18'].includes(r.id)){r.status='proven';r.notes='Scoped native engine proof described in checkpoint-4. Actual shared outputs, retained GPU source, output-sized composition, device validation, reused bounded transfer, forced GDI/native recovery and native decode pass. This is not protocol/UI/network/device completion.';}
  else if(['13.1','13.7','13.8','13.9','13.12','13.17'].includes(r.id)){r.status='awaiting-physical-validation';r.notes='Native current two-4K layout plus synthetic geometry, rotation, cursor-seam and separate-D3D-device fixtures pass. Actual different physical GPUs, portrait/mixed-DPI/gaps, cursor crossing, dimension rejection and live performance remain unproved.';}
  else{r.status='incomplete';r.notes='Capture engine implemented and natively exercised. H/I must complete advertised negotiated all-screens mode, ordered applied-frame/input state, Focus/PiP and actual transport regressions before this product clause/gate can be passed.';}
}
fs.writeFileSync(path,JSON.stringify(doc,null,2)+'\n');
