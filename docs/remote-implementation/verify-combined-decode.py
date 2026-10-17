"""Decode the actual native bitstream and verify owned target pixels only."""
import json, pathlib, subprocess, sys
root=pathlib.Path(__file__).parent/'evidence'
prefix=sys.argv[1]
record=json.loads((root/(prefix+'.json')).read_text())
results=[]
for suffix,view,expected_frames in [('',record['view'],record['encodedFrames']),('-single',record['singleNative']['view'],record['singleNative']['encodedFrames'])]:
    path=root/(prefix+suffix+'.h264')
    probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-count_frames','-show_entries','stream=width,height,nb_read_frames,codec_name','-of','json',str(path)]))['streams'][0]
    width,height=view['width'],view['height']
    assert (probe['width'],probe['height'],int(probe['nb_read_frames']))==(width,height,expected_frames)
    pixels=subprocess.check_output(['ffmpeg','-loglevel','error','-f','h264','-i',str(path),'-vf','select=eq(n\\,15)','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])
    assert len(pixels)==width*height*3
    source=view['source'];displays=[]
    for d in view['displays']:
        cx=(d['x']-source['x']+d['width']/2)*width/source['width'];cy=(d['y']-source['y']+d['height']/2)*height/source['height']
        offsets=[(-128,-64),(128,-64),(-128,64),(128,64)];samples=[]
        for ox,oy in offsets:
            x=int(cx+ox*width/source['width']);y=int(cy+oy*height/source['height']);i=(y*width+x)*3;samples.append(list(pixels[i:i+3]))
        def valid(p):
            if d['index']%2==0:return abs(p[0]-210)<=5 and abs(p[1]-35)<=5 and min(abs(p[2]-35),abs(p[2]-95))<=5
            return abs(p[1]-180)<=5 and abs(p[2]-55)<=5 and min(abs(p[0]-35),abs(p[0]-95))<=5
        passed=sum(map(valid,samples))>=3
        displays.append({'display':d['id'],'samplesRgb':samples,'passed':passed});assert passed
    results.append({'stream':suffix or 'combined','probe':probe,'displayChecks':displays})
(root/(prefix+'-decode.json')).write_text(json.dumps({'results':results,'scope':'Actual isolated NVENC Annex-B decoded by ffmpeg; owned moving-patch samples only, no network/device inference.'},indent=2)+'\n')
print(json.dumps({'streams':len(results),'decodedFrames':[r['probe']['nb_read_frames'] for r in results],'passed':True}))
