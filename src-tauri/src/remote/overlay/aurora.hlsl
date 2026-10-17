// Native desktop-only premultiplied decoration. Scissors restrict rasterization
// to edges and bounded cursor/ripple regions; the center receives a fast clear.
cbuffer Params : register(b0) {
    float4 screen;     // physical width,height,desktop origin x,y
    float4 flow;       // continuous integrated phase,intensity,fade,corner
    float4 border;     // thickness,opacity,glow,ribbons
    float4 aura;       // softness,reaction,tint strength,tint reach
    float4 primary;
    float4 secondary;
    float4 accent;
    float4 cursor;     // local hotspot x,y,velocity x,y
    float4 halo;       // radius,opacity,softness,response
    float4 rippleStyle;// size,strength,thickness,duration
    float4 effect;     // notice opacity,reduced motion,cursor visible,unused
    float4 ripples[8]; // local x,y,age,active
};
struct VOut {float4 position:SV_POSITION;};
VOut vs(uint id:SV_VertexID) {
    VOut o;float2 uv=float2((id<<1)&2,id&2);
    o.position=float4(uv*float2(2,-2)+float2(-1,1),0,1);return o;
}
float hash(float2 p) {p=frac(p*float2(0.1031,0.11369));p+=dot(p,p.yx+19.19);return frac((p.x+p.y)*p.x);}
float noise(float2 p) {
    float2 i=floor(p),f=frac(p);f=f*f*(3-2*f);
    return lerp(lerp(hash(i),hash(i+float2(1,0)),f.x),lerp(hash(i+float2(0,1)),hash(i+1),f.x),f.y);
}
float fbm(float2 p) {return noise(p)*0.57+noise(p*2.03+7.1)*0.29+noise(p*4.11+23.7)*0.14;}
float4 ps(VOut input):SV_TARGET {
    float2 p=input.position.xy,global=p+screen.zw;
    float2 q=abs(p-screen.xy*.5)-screen.xy*.5+flow.w;
    float sd=length(max(q,0))+min(max(q.x,q.y),0)-flow.w;
    if(sd>0)return 0;
    float edge=max(0,-sd),time=flow.x;
    float2 field=global*0.003;
    float n=fbm(field+float2(time*.12,-time*.09));
    float warp=fbm(field*.61+float2(-time*.05,time*.075)+n*1.8);
    float3 color=lerp(primary.rgb,secondary.rgb,smoothstep(.35,.9,warp)*.48);
    color=lerp(color,accent.rgb,smoothstep(.86,1.,n)*.3);
    float boundary=exp2(-pow(edge/max(.4,border.x),2)*1.7)*border.y;
    float along=(global.x+global.y)*.004+warp*2.2;
    float fine=sin(along*1.8+time*.35)+sin(along*.79-time*.19)*.5;
    float r1=5.+warp*10.+fine*2.;float r2=16.+n*20.+fine*3.;
    float ribbon=exp2(-pow((edge-r1)/(1.6+aura.x*3.5),2))*.14;
    ribbon+=exp2(-pow((edge-r2)/(2.+aura.x*5.),2))*.07;
    float mist=pow(n,.7)*exp2(-edge/max(2.,flow.z*.4))*.16*border.z;
    float fringe=(ribbon*border.w+mist)*exp2(-edge/max(2.,flow.z));
    float2 delta=p-cursor.xy;
    float nearCursor=effect.z*exp2(-dot(delta,delta)/18000.);
    float velocity=min(length(cursor.zw)/1200.,1.);
    fringe*=1.+nearCursor*aura.y*velocity*.5;
    float tint=aura.z*pow(1.-smoothstep(0.,max(1.,aura.w),edge),2);
    float alpha=saturate((boundary+fringe+tint)*flow.y);
    float3 premul=color*alpha;
    if(effect.z>.5&&halo.y>0.) {
        float2 direction=normalize(cursor.zw+float2(.001,0));
        float2 local=float2(dot(delta,direction),dot(delta,float2(-direction.y,direction.x)));
        local.x/=1.+velocity*halo.w*.2;
        float radius=length(local),width=max(1.,halo.x*(.1+halo.z*.24));
        float h=(exp2(-pow((radius-halo.x*.72)/width,2))*.6+exp2(-pow(radius/max(1.,halo.x),2))*.08)*halo.y*flow.y;
        premul=primary.rgb*h+premul*(1.-h);alpha=h+alpha*(1.-h);
    }
    [unroll]for(int i=0;i<8;i++)if(ripples[i].w>.5) {
        float life=saturate(ripples[i].z/max(.1,rippleStyle.w));
        float reach=rippleStyle.x*(.18+.82*(1.-pow(1.-life,3.)));
        float ring=exp2(-pow((length(p-ripples[i].xy)-reach)/max(.4,rippleStyle.z),2));
        float a=ring*pow(1.-life,2.)*rippleStyle.y*flow.y;
        premul=primary.rgb*a+premul*(1.-a);alpha=a+alpha*(1.-a);
    }
    // Spatial (not time-varying) sub-LSB dither avoids an animated noise carpet.
    if(alpha>.003){float d=(hash(p)-.5)/255.;float next=saturate(alpha+d);premul*=next/max(alpha,.00001);alpha=next;}
    return float4(premul,alpha)*effect.x;
}
