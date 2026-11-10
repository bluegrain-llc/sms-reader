//! Preserve JavaScript's isolated UTF-16 code units inside serde JSON values.
//! The private marker is escaped too, so ordinary Unicode cannot collide with it.
use serde_json::Value;
const MARK: char = '\u{f0000}';
pub fn encode(s: &str) -> String {
    s.replace(MARK, &format!("{MARK}{MARK}"))
}
pub fn units(s: &str) -> Vec<u16> {
    let mut out = vec![];
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == MARK {
            match chars.next() {
                Some(MARK) => out.extend(MARK.encode_utf16(&mut [0; 2]).iter().copied()),
                Some(c) if ('\u{e000}'..='\u{e7ff}').contains(&c) => {
                    out.push(0xd800 + (c as u16 - 0xe000))
                }
                Some(c) => {
                    out.extend(MARK.encode_utf16(&mut [0; 2]).iter().copied());
                    out.extend(c.encode_utf16(&mut [0; 2]).iter().copied());
                }
                None => out.extend(MARK.encode_utf16(&mut [0; 2]).iter().copied()),
            }
        } else {
            out.extend(c.encode_utf16(&mut [0; 2]).iter().copied());
        }
    }
    out
}
pub fn utf8(s: &str) -> String {
    String::from_utf16_lossy(&units(s))
}
pub fn storage(s: &str) -> Result<String, std::char::DecodeUtf16Error> {
    char::decode_utf16(units(s)).collect()
}
pub fn count(s: &str) -> usize {
    char::decode_utf16(units(s)).count()
}
pub fn quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in char::decode_utf16(units(s)) {
        match c {
            Ok(c) => {
                let quoted = serde_json::to_string(&c.to_string()).unwrap();
                out.push_str(&quoted[1..quoted.len() - 1]);
            }
            Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
        }
    }
    out.push('"');
    out
}
pub fn encode_value(v: &mut Value) {
    match v {
        Value::String(s) => *s = encode(s),
        Value::Array(a) => a.iter_mut().for_each(encode_value),
        Value::Object(m) => {
            *m = std::mem::take(m)
                .into_iter()
                .map(|(k, mut v)| {
                    encode_value(&mut v);
                    (encode(&k), v)
                })
                .collect();
        }
        _ => {}
    }
}
pub fn parse(raw: &[u8]) -> serde_json::Result<Value> {
    // Decode only string escapes here; serde remains responsible for JSON grammar.
    let source = String::from_utf8_lossy(raw);
    let mut chars = source.chars().peekable();
    let mut out = String::new();
    let mut inside = false;
    while let Some(c) = chars.next() {
        if c == '"' {
            inside = !inside;
            out.push(c);
            continue;
        }
        if !inside {
            out.push(c);
            continue;
        }
        if c == MARK {
            out.push(MARK);
            out.push(MARK);
            continue;
        }
        if c != '\\' {
            out.push(c);
            continue;
        }
        if chars.peek() != Some(&'u') {
            out.push(c);
            if let Some(c) = chars.next() {
                out.push(c);
            }
            continue;
        }
        chars.next();
        let digits = chars.by_ref().take(4).collect::<String>();
        let Some(unit) = u16::from_str_radix(&digits, 16)
            .ok()
            .filter(|_| digits.len() == 4)
        else {
            out.push_str("\\u");
            out.push_str(&digits);
            continue;
        };
        if (0xd800..=0xdbff).contains(&unit) {
            let mut next = chars.clone();
            if next.next() == Some('\\') && next.next() == Some('u') {
                let digits = next.by_ref().take(4).collect::<String>();
                if let Ok(low) = u16::from_str_radix(&digits, 16)
                    && digits.len() == 4
                    && (0xdc00..=0xdfff).contains(&low)
                {
                    chars = next;
                    let c = char::from_u32(
                        0x10000 + ((unit as u32 - 0xd800) << 10) + (low as u32 - 0xdc00),
                    )
                    .unwrap();
                    out.push(c);
                    if c == MARK {
                        out.push(c);
                    }
                    continue;
                }
            }
        }
        if (0xd800..=0xdfff).contains(&unit) {
            out.push(MARK);
            out.push(char::from_u32(0xe000 + unit as u32 - 0xd800).unwrap());
        } else {
            out.push_str("\\u");
            out.push_str(&digits);
        }
    }
    serde_json::from_str(&out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn javascript_strings_round_trip() {
        let fixtures = parse(include_bytes!("../compat/js-strings.json")).unwrap();
        for f in fixtures.as_array().unwrap() {
            let s = f["input"].as_str().unwrap();
            assert_eq!(quote(s), utf8(f["json"].as_str().unwrap()));
            assert_eq!(units(s).len() as u64, f["units"].as_u64().unwrap());
            assert_eq!(count(s) as u64, f["points"].as_u64().unwrap());
            assert_eq!(utf8(s), utf8(f["utf8"].as_str().unwrap()));
            assert_eq!(
                crate::model::hash(&quote(s)),
                f["jsonHash"].as_str().unwrap()
            );
        }
        for source in [
            r#""\ud800""#,
            r#""\udfff""#,
            r#""\ud800\ud800""#,
            r#""\ud83d\ude00""#,
            r#""\udb80\udc00\ue000""#,
            r#""\\ud800""#,
        ] {
            let v = parse(source.as_bytes()).unwrap();
            let s = v.as_str().unwrap();
            let rendered = quote(s);
            assert_eq!(parse(rendered.as_bytes()).unwrap(), v);
        }
        let v = parse(br#""\ud800""#).unwrap();
        let s = v.as_str().unwrap();
        assert_eq!(quote(s), r#""\ud800""#);
        assert_eq!(utf8(s), "\u{fffd}");
        assert_eq!(count(s), 1);
        assert_eq!(units(s).len(), 1);
        assert_eq!(utf8(&encode("\u{f0000}\u{e000}")), "\u{f0000}\u{e000}");
    }
}
