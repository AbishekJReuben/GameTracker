import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../..',import.meta.url));
export default defineConfig({root,resolve:{alias:{'@':fileURLToPath(new URL('../../src',import.meta.url))}},optimizeDeps:{entries:['docs/remote-implementation/parent-epoch-probe.html']},server:{host:'127.0.0.1',port:14883,strictPort:true},clearScreen:false});
