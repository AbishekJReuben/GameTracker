import http from 'node:http';
import {readFile} from 'node:fs/promises';
const page=new URL('./parent-rtc-sink-probe.html',import.meta.url);
const server=http.createServer(async(request,response)=>{
  if(request.method!=='GET'||request.url!=='/'){response.writeHead(404);response.end();return;}
  response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});response.end(await readFile(page));
});
server.listen(14882,'127.0.0.1',()=>process.stdout.write('Parent synthetic RTC sink probe on http://127.0.0.1:14882/\n'));
