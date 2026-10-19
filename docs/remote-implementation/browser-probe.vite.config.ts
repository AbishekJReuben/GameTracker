import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { readFileSync } from 'node:fs';
const root=path.resolve(__dirname,'../..');
export default defineConfig({root,plugins:[react(),tailwindcss()],resolve:{alias:{'@':path.join(root,'src')}},define:{__APP_VERSION__:JSON.stringify(JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version)},server:{host:'127.0.0.1',port:14879,strictPort:true,watch:{ignored:['**/target/**','**/src-tauri/**','**/signaling/**','**/.logs/**','**/dist/**']}}});
