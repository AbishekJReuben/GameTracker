//! Reads a shortcut like "Ctrl+Shift+Space" into what `RegisterHotKey` takes.

pub const MOD_ALT: u32 = 0x0001;
pub const MOD_CONTROL: u32 = 0x0002;
pub const MOD_SHIFT: u32 = 0x0004;
pub const MOD_WIN: u32 = 0x0008;

fn key(name: &str) -> Option<u32> {
    let upper = name.to_ascii_uppercase();
    if upper.len() == 1 {
        let c = upper.as_bytes()[0];
        if c.is_ascii_alphanumeric() {
            return Some(c as u32);
        }
        return Some(match c {
            b';' => 0xBA,
            b'=' => 0xBB,
            b',' => 0xBC,
            b'-' => 0xBD,
            b'.' => 0xBE,
            b'/' => 0xBF,
            b'`' => 0xC0,
            b'[' => 0xDB,
            b'\\' => 0xDC,
            b']' => 0xDD,
            b'\'' => 0xDE,
            _ => return None,
        });
    }
    if let Some(n) = upper.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
        return (1..=24).contains(&n).then_some(0x70 + n - 1);
    }
    Some(match upper.as_str() {
        "SPACE" => 0x20,
        "TAB" => 0x09,
        "ENTER" | "RETURN" => 0x0D,
        "PAGEUP" => 0x21,
        "PAGEDOWN" => 0x22,
        "END" => 0x23,
        "HOME" => 0x24,
        "LEFT" => 0x25,
        "UP" => 0x26,
        "RIGHT" => 0x27,
        "DOWN" => 0x28,
        "INSERT" => 0x2D,
        "DELETE" => 0x2E,
        _ => return None,
    })
}

/// `(modifiers, virtual key)`. A plain letter on its own isn't accepted: it would
/// swallow that key in every app. Function keys are fine alone.
pub fn parse(text: &str) -> Option<(u32, u32)> {
    let (mut mods, mut vk) = (0, None);
    for part in text.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods |= MOD_CONTROL,
            "shift" => mods |= MOD_SHIFT,
            "alt" => mods |= MOD_ALT,
            "win" | "meta" | "super" => mods |= MOD_WIN,
            _ if vk.is_none() => vk = Some(key(part)?),
            _ => return None,
        }
    }
    let vk = vk?;
    let function_key = (0x70..=0x87).contains(&vk);
    (function_key || mods & !MOD_SHIFT != 0).then_some((mods, vk))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_shortcut_parses() {
        assert_eq!(parse("Ctrl+Shift+Space"), Some((MOD_CONTROL | MOD_SHIFT, 0x20)));
    }

    #[test]
    fn case_and_spacing_do_not_matter() {
        assert_eq!(parse(" alt + n "), Some((MOD_ALT, b'N' as u32)));
        assert_eq!(parse("WIN+shift+F13"), Some((MOD_WIN | MOD_SHIFT, 0x7C)));
    }

    #[test]
    fn function_keys_may_stand_alone() {
        assert_eq!(parse("F9"), Some((0, 0x78)));
    }

    #[test]
    fn keys_that_would_break_typing_are_refused() {
        assert_eq!(parse("A"), None);
        assert_eq!(parse("Shift+A"), None);
        assert_eq!(parse("Ctrl+Shift"), None);
        assert_eq!(parse("Ctrl+A+B"), None);
        assert_eq!(parse("Ctrl+Nonsense"), None);
        assert_eq!(parse(""), None);
    }
}
