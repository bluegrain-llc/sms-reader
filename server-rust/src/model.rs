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
pub fn secret() -> String {
    let mut b = [0; 32];
    rand::rng().fill_bytes(&mut b);
    format!("smsr_{}", URL_SAFE_NO_PAD.encode(b))
}
pub fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
pub fn num(v: &Value, k: &str) -> i64 {
    v[k].as_i64()
        .or_else(|| v[k].as_f64().filter(|n| n.fract() == 0.0).map(|n| n as i64))
        .unwrap_or(0)
}
// JSON.parse represents every number as IEEE-754, including integer tokens.
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
        Value::Object(m) => m.values_mut().for_each(js_numbers),
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
            let index = |k: &str| {
                k.parse::<u32>()
                    .ok()
                    .filter(|n| *n < u32::MAX && n.to_string() == k)
            };
            let mut keys = m.keys().collect::<Vec<_>>();
            if canonical {
                keys.sort_by_key(|a| crate::js_string::units(a));
            }
            keys.sort_by_key(|k| index(k).map(|n| (0, n)).unwrap_or((1, 0)));
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
