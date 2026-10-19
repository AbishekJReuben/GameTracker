/** Local browser clipboard only: never forwards text as remote keyboard input. */
export async function copyBrowserText(text:string):Promise<void>{
  try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return;}}catch{/* Try the gesture-scoped selection fallback below. */}
  const previous=document.activeElement as HTMLElement|null;
  const field=document.createElement('textarea');field.value=text;field.readOnly=true;
  field.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;';
  document.body.appendChild(field);
  try{
    field.focus({preventScroll:true});field.select();field.setSelectionRange(0,text.length);
    if(typeof document.execCommand!=='function'||!document.execCommand('copy'))throw new Error('Select the note text and use your browser’s Copy command.');
  }finally{field.remove();if(previous?.isConnected)previous.focus({preventScroll:true});}
}

export async function copyBrowserImage(url:string,mime='image/png'):Promise<void>{
  if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined')throw new Error('Image copying is unavailable in this browser. Use Save image instead.');
  // Desktop clipboard captures are PNG. Other image types can still be saved.
  if(mime!=='image/png')throw new Error('Use Save image for this image format.');
  const data=fetch(url).then(response=>{if(!response.ok)throw new Error('Image could not be loaded.');return response.blob();});
  // Start the clipboard write inside the click gesture, before awaiting the Blob.
  await navigator.clipboard.write([new ClipboardItem({'image/png':data})]);
}
