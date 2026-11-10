use crate::{
    error::{Result, ensure},
    model::*,
};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::OnceLock};
pub const EVENTS: [&str; 10] = [
    "request.created",
    "notification.accepted",
    "notification.tapped",
    "request.opened",
    "input.ready",
    "input.timeout",
    "request.submitted",
    "request.declined",
    "request.cancelled",
    "request.expired",
];
struct Contract {
    name: &'static str,
    schema: Value,
    validator: jsonschema::Validator,
    lengths: Lengths,
}
fn contract(name: &str) -> &'static Contract {
    static CONTRACTS: OnceLock<Vec<Contract>> = OnceLock::new();
    CONTRACTS
        .get_or_init(|| {
            [
                ("form", include_str!("../compat/form.schema.json")),
                (
                    "submission",
                    include_str!("../compat/submission.schema.json"),
                ),
                (
                    "observation",
                    include_str!("../compat/observation.schema.json"),
                ),
                ("webhook", include_str!("../compat/webhook.schema.json")),
                ("sms", include_str!("../compat/sms.schema.json")),
            ]
            .into_iter()
            .map(|(name, source)| {
                let schema = serde_json::from_str(source).unwrap();
                let validator = compile(&schema);
                let lengths = Lengths::new(&schema);
                Contract {
                    name,
                    schema,
                    validator,
                    lengths,
                }
            })
            .collect()
        })
        .iter()
        .find(|c| c.name == name)
        .unwrap()
}
pub fn schema(name: &str) -> &'static Value {
    &contract(name).schema
}
fn without_lengths(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(k, _)| !["minLength", "maxLength", "default"].contains(&k.as_str()))
                .map(|(k, v)| {
                    (
                        k.clone(),
                        if k == "properties" {
                            Value::Object(
                                v.as_object()
                                    .unwrap()
                                    .iter()
                                    .map(|(name, schema)| (name.clone(), without_lengths(schema)))
                                    .collect(),
                            )
                        } else {
                            without_lengths(v)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(a) => json!(a.iter().map(without_lengths).collect::<Vec<_>>()),
        _ => v.clone(),
    }
}
#[cfg(test)]
static COMPILATIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
fn compile(schema: &Value) -> jsonschema::Validator {
    #[cfg(test)]
    COMPILATIONS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    jsonschema::validator_for(&without_lengths(schema)).unwrap()
}
// This mirrors the schema tree once. Each union branch keeps its structural
// validator alongside the recursive JavaScript string-length checks.
struct Lengths {
    min: Option<u64>,
    max: Option<u64>,
    properties: std::collections::HashMap<String, Lengths>,
    additional: Option<Box<Lengths>>,
    items: Option<Box<Lengths>>,
    unions: Vec<Vec<(jsonschema::Validator, Lengths)>>,
}
impl Lengths {
    fn new(schema: &Value) -> Self {
        Self {
            min: schema["minLength"].as_u64(),
            max: schema["maxLength"].as_u64(),
            properties: schema["properties"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.iter())
                .map(|(k, s)| (k.clone(), Self::new(s)))
                .collect(),
            additional: schema["additionalProperties"]
                .is_object()
                .then(|| Box::new(Self::new(&schema["additionalProperties"]))),
            items: schema.get("items").map(|s| Box::new(Self::new(s))),
            unions: ["oneOf", "anyOf"]
                .into_iter()
                .filter_map(|key| schema[key].as_array())
                .map(|branches| {
                    branches
                        .iter()
                        .map(|s| (compile(s), Self::new(s)))
                        .collect()
                })
                .collect(),
        }
    }
    fn valid(&self, v: &Value) -> bool {
        if let Some(s) = v.as_str() {
            let n = crate::js_string::count(s) as u64;
            if self.min.is_some_and(|m| n < m) || self.max.is_some_and(|m| n > m) {
                return false;
            }
        }
        if let Some(m) = v.as_object() {
            for (k, v) in m {
                if let Some(prop) = self.properties.get(k).or(self.additional.as_deref())
                    && !prop.valid(v)
                {
                    return false;
                }
            }
        }
        if let (Some(a), Some(items)) = (v.as_array(), self.items.as_deref())
            && !a.iter().all(|v| items.valid(v))
        {
            return false;
        }
        self.unions.iter().all(|branches| {
            branches
                .iter()
                .any(|(validator, lengths)| validator.is_valid(v) && lengths.valid(v))
        })
    }
}
pub fn validate(name: &str, v: &Value) -> Result<()> {
    fn finite(v: &Value) -> bool {
        match v {
            Value::Number(n) => n.as_f64().is_some(),
            Value::Array(a) => a.iter().all(finite),
            Value::Object(m) => m.values().all(finite),
            _ => true,
        }
    }
    let contract = contract(name);
    ensure(
        finite(v)
            && contract.validator.is_valid(v)
            && contract.lengths.valid(v)
            && (name != "webhook"
                || v["url"]
                    .as_str()
                    .is_some_and(|s| url::Url::parse(&crate::js_string::utf8(s)).is_ok())),
        400,
        "invalid_input",
    )
}
pub fn submission(mut input: Value) -> Result<Value> {
    // The legacy Zod record parser discards this own key before validation.
    if let Some(values) = input.get_mut("values").and_then(Value::as_object_mut) {
        values.remove("__proto__");
    }
    validate("submission", &input)?;
    Ok(input)
}
fn unique(a: &[Value], k: &str) -> bool {
    let mut set = HashSet::new();
    a.iter().all(|v| set.insert(text(v, k)))
}
fn trim(v: &mut Value, k: &str) {
    if let Some(s) = v[k].as_str() {
        v[k] = json!(s.trim_matches(js_whitespace));
    }
}
pub fn definition(mut v: Value) -> Result<Value> {
    if !v.is_object() {
        return Err(crate::error::Error::Api(400, "invalid_input"));
    }
    trim(&mut v, "title");
    if v.get("fields").is_none() {
        v["fields"] = json!([]);
    }
    if v.get("expiresInSeconds").is_none() {
        v["expiresInSeconds"] = json!(86400);
    }
    if let Some(fields) = v["fields"].as_array_mut() {
        for f in fields {
            if !f.is_object() {
                continue;
            }
            trim(f, "label");
            if f.get("required").is_none() {
                f["required"] = json!(false);
            }
            if ["text", "multiline"].contains(&text(f, "type")) && f.get("maxLength").is_none() {
                f["maxLength"] = json!(1000);
            }
            if let Some(opts) = f.get_mut("options").and_then(Value::as_array_mut) {
                for o in opts {
                    if o.is_object() {
                        trim(o, "label");
                    }
                }
            }
        }
    }
    if let Some(a) = v["actions"].as_array_mut() {
        for a in a {
            if a.is_object() {
                trim(a, "label");
            }
        }
    }
    if let Some(steps) = v.get_mut("steps").and_then(Value::as_array_mut) {
        for s in steps {
            if s.is_object() {
                trim(s, "title");
            }
        }
    }
    validate("form", &v)?;
    let fields = arr(&v, "fields");
    let actions = arr(&v, "actions");
    ensure(
        unique(&fields, "id") && unique(&actions, "id"),
        400,
        "invalid_input",
    )?;
    for f in &fields {
        ensure(
            f.get("options").is_none() || unique(&arr(f, "options"), "id"),
            400,
            "invalid_input",
        )?;
        ensure(
            !(text(f, "type") == "number"
                && f["min"]
                    .as_f64()
                    .zip(f["max"].as_f64())
                    .is_some_and(|(a, b)| a > b)),
            400,
            "invalid_input",
        )?;
    }
    ensure(
        fields
            .iter()
            .filter(|f| text(f, "input") == "sms_code")
            .count()
            <= 1,
        400,
        "invalid_input",
    )?;
    if let Some(steps) = v["steps"].as_array() {
        ensure(unique(steps, "id"), 400, "invalid_input")?;
        let mut seen = HashSet::new();
        for step in steps {
            if let Some(c) = step.get("when") {
                let fid = text(c, "fieldId");
                let source = fields.iter().find(|f| text(f, "id") == fid);
                let compatible = source.is_some_and(|f| {
                    if c.get("contains").is_some() {
                        text(f, "type") == "multiple_choice"
                            && arr(f, "options").iter().any(|o| o["id"] == c["contains"])
                    } else {
                        let val = &c["equals"];
                        match text(f, "type") {
                            "checkbox" => val.is_boolean(),
                            "number" => val.is_number(),
                            "single_choice" => arr(f, "options").iter().any(|o| o["id"] == *val),
                            "multiple_choice" => false,
                            _ => val.is_string(),
                        }
                    }
                });
                ensure(seen.contains(fid) && compatible, 400, "invalid_input")?;
            }
            for id in arr(step, "fieldIds") {
                let id = id.as_str().unwrap().to_owned();
                ensure(
                    !seen.contains(id.as_str()) && fields.iter().any(|f| text(f, "id") == id),
                    400,
                    "invalid_input",
                )?;
                seen.insert(id);
            }
        }
        ensure(seen.len() == fields.len(), 400, "invalid_input")?;
    }
    Ok(v)
}
pub fn visible_fields(def: &Value, values: &Value) -> Vec<Value> {
    let Some(steps) = def["steps"].as_array() else {
        return arr(def, "fields");
    };
    let mut available = HashSet::new();
    for step in steps {
        if let Some(c) = step.get("when") {
            let fid = text(c, "fieldId");
            if !available.contains(fid) {
                continue;
            }
            let source = arr(def, "fields")
                .into_iter()
                .find(|f| text(f, "id") == fid)
                .unwrap();
            let value = js_property(values, fid).cloned().unwrap_or(
                if text(&source, "type") == "checkbox" {
                    json!(false)
                } else {
                    Value::Null
                },
            );
            if c.get("equals").is_some() {
                if !js_equal(&value, &c["equals"]) {
                    continue;
                }
            } else if !value.as_array().is_some_and(|a| a.contains(&c["contains"])) {
                continue;
            }
        }
        for id in arr(step, "fieldIds") {
            available.insert(id.as_str().unwrap().to_owned());
        }
    }
    arr(def, "fields")
        .into_iter()
        .filter(|f| available.contains(text(f, "id")))
        .collect()
}
fn js_equal(a: &Value, b: &Value) -> bool {
    if a.is_number() && b.is_number() {
        a.as_f64() == b.as_f64()
    } else {
        a == b
    }
}
pub fn validate_submission(def: &Value, input: &Value) -> Result<&'static str> {
    validate("submission", input)?;
    let actions = arr(def, "actions");
    let action = actions.iter().find(|a| a["id"] == input["action"]);
    ensure(action.is_some(), 400, "unknown_action")?;
    let values = input["values"].as_object().unwrap();
    if text(action.unwrap(), "type") == "decline" {
        ensure(values.is_empty(), 400, "decline_has_values")?;
        return Ok("declined");
    }
    let all = arr(def, "fields");
    let fields = visible_fields(def, &input["values"]);
    ensure(
        values
            .keys()
            .all(|id| all.iter().any(|f| text(f, "id") == id)),
        400,
        "unknown_field",
    )?;
    ensure(
        values
            .keys()
            .all(|id| fields.iter().any(|f| text(f, "id") == id)),
        400,
        "hidden_field",
    )?;
    for f in fields {
        let v = js_property(&input["values"], text(&f, "id"));
        let missing =
            v.is_none_or(|v| v.as_str() == Some("") || v.as_array().is_some_and(Vec::is_empty));
        ensure(!flag(&f, "required") || !missing, 400, "required_field")?;
        let Some(v) = v else { continue };
        match text(&f, "type") {
            "text" | "multiline" => {
                ensure(
                    v.as_str()
                        .is_some_and(|s| js_len(s) <= num(&f, "maxLength") as usize),
                    400,
                    "invalid_text",
                )?;
                if text(&f, "input") == "sms_code" && v != "" {
                    ensure(v.as_str().is_some_and(code), 400, "invalid_code")?;
                }
            }
            "number" => ensure(
                v.as_f64().is_some_and(|n| {
                    f["min"].as_f64().is_none_or(|m| n >= m)
                        && f["max"].as_f64().is_none_or(|m| n <= m)
                }),
                400,
                "invalid_number",
            )?,
            "checkbox" => ensure(
                v.as_bool().is_some_and(|b| !flag(&f, "required") || b),
                400,
                "invalid_checkbox",
            )?,
            "single_choice" => ensure(
                v.is_string() && arr(&f, "options").iter().any(|o| o["id"] == *v),
                400,
                "invalid_choice",
            )?,
            "multiple_choice" => ensure(
                v.as_array().is_some_and(|a| {
                    a.iter().enumerate().all(|(i, v)| {
                        !a[..i].contains(v) && arr(&f, "options").iter().any(|o| o["id"] == *v)
                    })
                }),
                400,
                "invalid_choices",
            )?,
            "date" => ensure(
                v.as_str().is_some_and(|s| {
                    s.len() == 10
                        && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                            .ok()
                            .is_some_and(|d| d.format("%Y-%m-%d").to_string() == s)
                }),
                400,
                "invalid_date",
            )?,
            _ => unreachable!(),
        }
    }
    Ok("submitted")
}
pub fn form_view(r: &Value) -> Value {
    let mut v = r["definition"].clone();
    v.as_object_mut().unwrap().remove("idempotencyKey");
    v["requestId"] = r["id"].clone();
    v["callerName"] = r["callerName"].clone();
    for k in [
        "status",
        "createdAt",
        "expiresAt",
        "terminatedAt",
        "resultExpiresAt",
        "firstOpenedAt",
        "helpers",
    ] {
        v[k] = r[k].clone();
    }
    v["completedByDeviceId"] = r["winner"]["deviceId"].clone();
    v
}
pub fn public_event(mut e: Value) -> Value {
    for k in ["ownerId", "grantId", "purgeAt", "__id"] {
        e.as_object_mut().unwrap().remove(k);
    }
    e
}

#[cfg(test)]
mod caching_tests {
    use super::*;
    use std::sync::atomic::Ordering;
    #[test]
    fn recursive_validators_are_compiled_once_for_large_records() {
        let _ = contract("submission"); // Initializes every contract and all recursive branches.
        let compiled = COMPILATIONS.load(Ordering::Relaxed);
        assert!(compiled > 5);
        let values: serde_json::Map<String, Value> = (0..10_000)
            .map(|i| (format!("field_{i}"), json!(true)))
            .collect();
        let mut input = json!({"submissionId":"large","action":"send","values":values});
        for _ in 0..3 {
            assert!(validate("submission", &input).is_ok());
        }
        input["values"]["field_0"] = json!("a".repeat(4001));
        assert!(validate("submission", &input).is_err());
        input["values"]["field_0"] = json!(["legal_id"]);
        assert!(validate("submission", &input).is_ok());
        input["values"]["field_0"] = json!(["illegal id"]);
        assert!(validate("submission", &input).is_err());
        input["values"]["field_0"] = json!({"unknown":true});
        assert!(validate("submission", &input).is_err());
        // Astral Unicode retains Zod code-point length behavior in union branches.
        input["values"]["field_0"] = json!("😀".repeat(4000));
        assert!(validate("submission", &input).is_ok());
        input["values"]["field_0"] = json!("😀".repeat(4001));
        assert!(validate("submission", &input).is_err());
        assert_eq!(COMPILATIONS.load(Ordering::Relaxed), compiled);
    }
}
