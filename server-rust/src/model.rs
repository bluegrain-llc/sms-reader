use crate::error::{Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
pub const MINUTE: i64 = 60_000;
pub const DAY: i64 = 86_400_000;
pub const HISTORY: i64 = 7 * DAY;
pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
/// Hash a string held in the internal JavaScript UTF-16 representation.
/// Serialized JSON is already raw UTF-8 and must continue to use `hash`.
pub fn hash_js(s: &str) -> String {
    hash(&crate::js_string::utf8(s))
}
pub fn secret() -> String {
    let mut b = [0; 32];
    rand::rng().fill_bytes(&mut b);
    format!("smsr_{}", URL_SAFE_NO_PAD.encode(b))
}
pub fn js_property<'a>(values: &'a Value, key: &str) -> Option<&'a Value> {
    values.get(key).or_else(|| {
        // Legacy maps are ordinary JS objects: omitted prototype names resolve
        // to a non-primitive value. Never persist this lookup-only sentinel.
        static INHERITED: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
        matches!(
            key,
            "constructor"
                | "__defineGetter__"
                | "__defineSetter__"
                | "hasOwnProperty"
                | "__lookupGetter__"
                | "__lookupSetter__"
                | "isPrototypeOf"
                | "propertyIsEnumerable"
                | "toString"
                | "valueOf"
                | "__proto__"
                | "toLocaleString"
        )
        .then(|| INHERITED.get_or_init(|| json!({})))
    })
}
pub fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
pub fn num(v: &Value, k: &str) -> i64 {
    v[k].as_i64()
        .or_else(|| v[k].as_f64().filter(|n| n.fract() == 0.0).map(|n| n as i64))
        .unwrap_or(0)
}
fn array_index(k: &str) -> Option<u32> {
    k.parse::<u32>()
        .ok()
        .filter(|n| *n < u32::MAX && n.to_string() == k)
}
// JSON.parse uses IEEE-754 numbers and enumerates array-index keys numerically.
pub fn js_numbers(value: &mut Value) {
    match value {
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                *n = if f.fract() == 0.0
                    && (-9_223_372_036_854_775_808.0..9_223_372_036_854_775_808.0).contains(&f)
                {
                    (f as i64).into()
                } else {
                    serde_json::Number::from_f64(f).unwrap()
                };
            }
        }
        Value::Array(a) => a.iter_mut().for_each(js_numbers),
        Value::Object(m) => {
            let mut entries = std::mem::take(m).into_iter().collect::<Vec<_>>();
            entries.sort_by_key(|(k, _)| array_index(k).map(|n| (0, n)).unwrap_or((1, 0)));
            *m = entries
                .into_iter()
                .map(|(k, mut v)| {
                    js_numbers(&mut v);
                    (k, v)
                })
                .collect();
        }
        _ => {}
    }
}
pub fn flag(v: &Value, k: &str) -> bool {
    v[k].as_bool().unwrap_or(false)
}
pub fn arr(v: &Value, k: &str) -> Vec<Value> {
    v[k].as_array().cloned().unwrap_or_default()
}
pub fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
pub fn js_len(s: &str) -> usize {
    crate::js_string::units(s).len()
}
pub fn id(s: &str) -> Result<()> {
    ensure(
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'),
        400,
        "invalid_input",
    )
}
pub fn valid_secret(s: &str) -> bool {
    s.len() == 48
        && s.starts_with("smsr_")
        && s[5..]
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
pub fn code(s: &str) -> bool {
    (4..=10).contains(&s.len())
        && s.bytes().all(|c| c.is_ascii_alphanumeric())
        && s.bytes().any(|c| c.is_ascii_digit())
}
pub fn strict(v: &Value, keys: &[&str]) -> Result<()> {
    ensure(
        v.as_object()
            .is_some_and(|m| m.keys().all(|k| keys.contains(&k.as_str()))),
        400,
        "invalid_input",
    )
}
pub fn string(v: &Value, k: &str, min: usize, max: usize, trim: bool) -> Result<String> {
    let s = v[k]
        .as_str()
        .ok_or(crate::error::Error::Api(400, "invalid_input"))?;
    let s = if trim {
        s.trim_matches(js_whitespace)
    } else {
        s
    };
    ensure(
        (min..=max).contains(&crate::js_string::count(s)),
        400,
        "invalid_input",
    )?;
    Ok(s.to_owned())
}
pub fn integer(v: &Value, k: &str, min: i64, max: i64, default: Option<i64>) -> Result<i64> {
    let max = max.min(9_007_199_254_740_991);
    let n = if v.get(k).is_none() {
        default
    } else {
        v[k].as_f64().filter(|x| x.fract() == 0.0).map(|x| x as i64)
    };
    ensure(
        n.is_some_and(|n| (min..=max).contains(&n)),
        400,
        "invalid_input",
    )?;
    Ok(n.unwrap())
}
pub fn bump(rate: &Value, now: i64, max: i64) -> Result<Value> {
    let r = if now - num(rate, "start") >= 10 * MINUTE {
        json!({"start":now,"count":1})
    } else {
        json!({"start":num(rate,"start"),"count":num(rate,"count")+1})
    };
    ensure(num(&r, "count") <= max, 429, "rate_limited")?;
    Ok(r)
}
pub fn rate(v: &Value, k: &str, now: i64) -> Value {
    v.get(k).cloned().unwrap_or(json!({"start":now,"count":0}))
}
pub fn active(s: &str) -> bool {
    ["queued", "pending_phone", "ready", "awaiting_consent"].contains(&s)
}
pub fn deadline(r: &Value) -> i64 {
    num(r, "expiresAt").min(
        r["listeningDeadline"]
            .as_i64()
            .unwrap_or(num(r, "expiresAt")),
    )
}
pub fn view(r: &Value) -> Value {
    json!({"requestId":r["id"],"status":r["status"],"reason":r["reason"],"expiresAt":r["expiresAt"],"listeningDeadline":r["listeningDeadline"],"resultExpiresAt":r["resultExpiresAt"]})
}
pub fn sms_input(v: &Value) -> Result<Value> {
    strict(v, &["purpose", "title", "senderPhone", "idempotencyKey"])?;
    let mut out = json!({"purpose":string(v,"purpose",1,4000,true)?,"idempotencyKey":string(v,"idempotencyKey",8,128,false)?});
    if v.get("title").is_some() {
        out["title"] = json!(string(v, "title", 1, 80, true)?);
    }
    if let Some(p) = v.get("senderPhone") {
        let s = p.as_str().unwrap_or("");
        ensure(
            regex::Regex::new(r"^\+[1-9][0-9]{5,14}$")
                .unwrap()
                .is_match(s),
            400,
            "invalid_input",
        )?;
        out["senderPhone"] = p.clone();
    }
    Ok(out)
}
// ECMAScript JSON.stringify orders array-index keys numerically, even after lexical sorting.
pub fn js_json(v: &Value, canonical: bool) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::String(s) => crate::js_string::quote(s),
        Value::Number(n) => n
            .as_f64()
            .map(|n| ryu_js::Buffer::new().format(n).to_owned())
            .unwrap_or_else(|| "null".into()),
        Value::Array(a) => format!(
            "[{}]",
            a.iter()
                .map(|x| js_json(x, canonical))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(m) => {
            let mut keys = m.keys().collect::<Vec<_>>();
            if canonical {
                keys.sort_by_key(|a| crate::js_string::units(a));
            }
            keys.sort_by_key(|k| array_index(k).map(|n| (0, n)).unwrap_or((1, 0)));
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|k| format!(
                        "{}:{}",
                        crate::js_string::quote(k),
                        js_json(&m[*k], canonical)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}
pub fn sms_fingerprint(i: &Value) -> String {
    let mut a = vec![i["purpose"].clone(), i["senderPhone"].clone()];
    if let Some(t) = i.get("title") {
        a.push(t.clone());
    }
    hash(&js_json(&json!(a), false))
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    #[test]
    fn identity_hash_decodes_internal_strings_but_json_hash_remains_raw() {
        let raw = "owner-\u{f0000}\u{e000}";
        let encoded = crate::js_string::encode(raw);
        assert_ne!(hash(raw), hash(&encoded));
        assert_eq!(hash_js(&encoded), hash(raw));
        let serialized = js_json(&json!({"owner":encoded}), true);
        assert_eq!(
            serialized,
            serde_json::to_string(&json!({"owner":raw})).unwrap()
        );
        assert_eq!(
            hash(&serialized),
            hash(&serde_json::to_string(&json!({"owner":raw})).unwrap())
        );
        assert_ne!(hash_js(&serialized), hash(&serialized));
    }
}
