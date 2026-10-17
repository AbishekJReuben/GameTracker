//! Appearance defaults/ranges are the same JSON the client consumes. The only
//! constructor validates; native rendering never receives raw preference JSON.
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;
static SCHEMA: Lazy<Value> = Lazy::new(|| serde_json::from_str(include_str!("../../../src/shared/desktopAppearance.json")).expect("embedded appearance schema"));
#[derive(Clone,Debug,PartialEq,Serialize)]
#[serde(transparent)]
pub struct Appearance(Value);
impl Default for Appearance { fn default()->Self { Self(SCHEMA["defaults"].clone()) } }
impl Appearance {
    pub fn preset(name:&str)->Self {
        let mut value=SCHEMA["defaults"].clone();
        if let Some(fields)=SCHEMA["presets"][name].as_object(){for(path,setting)in fields{
            if let Some((group,key))=path.split_once('.') {value[group][key]=setting.clone();}else{value[path]=setting.clone();}
        }}Self::validate(&value)
    }
    pub fn validate(raw:&Value)->Self {
        let mut value=SCHEMA["defaults"].clone();
        for (path,range) in SCHEMA["ranges"].as_object().into_iter().flatten() {
            let parts:Vec<_>=path.split('.').collect();
            let input=if parts.len()==1 { &raw[parts[0]] } else { &raw[parts[0]][parts[1]] };
            if let Some(n)=input.as_f64().filter(|n|n.is_finite()) {
                let bounded=n.clamp(range[0].as_f64().unwrap_or(0.),range[1].as_f64().unwrap_or(1.));
                if parts.len()==1 { value[parts[0]]=Value::from(bounded); } else { value[parts[0]][parts[1]]=Value::from(bounded); }
            }
        }
        for key in ["primary","secondary","accent"] {
            if let Some(s)=raw["palette"][key].as_str().filter(|s|s.len()==7 && s.starts_with('#') && s.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)) {value["palette"][key]=Value::from(s.to_ascii_lowercase());}
        }
        for key in ["halo","ripples"] { if let Some(enabled)=raw[key]["enabled"].as_bool() {value[key]["enabled"]=Value::from(enabled);} }
        if let Some(p)=raw["label"]["placement"].as_str().filter(|p|matches!(*p,"topCenter"|"topLeft"|"topRight")) {value["label"]["placement"]=Value::from(p);}
        if raw["motion"]=="reduce" {value["motion"]=Value::from("reduce");}
        Self(value)
    }
    fn get(&self,path:&str)->&Value {path.split('.').fold(&self.0,|v,k|&v[k])}
    pub fn number(&self,path:&str)->f32 {self.get(path).as_f64().unwrap_or(0.) as f32}
    pub fn enabled(&self,path:&str)->bool {self.get(path).as_bool().unwrap_or(false)}
    pub fn text(&self,path:&str)->&str {self.get(path).as_str().unwrap_or("")}
    pub fn color(&self,path:&str)->[f32;3] {
        let s=self.text(path);
        let n=u32::from_str_radix(s.trim_start_matches('#'),16).unwrap_or(0);
        [((n>>16)&255) as f32/255.,((n>>8)&255) as f32/255.,(n&255) as f32/255.]
    }
}
pub fn display_name(raw:&str)->String {
    let clean:String=raw.chars().take(1024).map(|c| if c.is_control() || matches!(c,'\u{2028}'|'\u{2029}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}') {' '} else {c}).collect();
    let trimmed:String=clean.trim().chars().take(48).collect();
    if trimmed.trim().is_empty() {"Remote User".into()} else {trimmed.trim().into()}
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn validates_every_render_input_and_unicode_identity() {
        let a=Appearance::validate(&serde_json::json!({"intensity":-2,"border":{"thickness":1e100},"palette":{"primary":"#AABBCC","accent":"url(x)"},"halo":{"enabled":false},"motion":"reduce"}));
        assert_eq!(a.number("intensity"),0.);assert_eq!(a.number("border.thickness"),8.);assert_eq!(a.text("palette.primary"),"#aabbcc");assert_eq!(a.text("palette.accent"),"#9372df");assert!(!a.enabled("halo.enabled"));
        assert_eq!(display_name(" \n\u{202e} "),"Remote User");assert_eq!(display_name(" அருள் 👩🏽‍💻 "),"அருள் 👩🏽‍💻");assert_eq!(display_name(&"😀".repeat(100)).chars().count(),48);
    }
}
