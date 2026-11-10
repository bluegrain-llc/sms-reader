//! Captured Zod input semantics used by the existing MCP SDK registration.
use crate::model::{js_whitespace, text};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::OnceLock};

fn parsers() -> &'static Value {
    static PARSERS: OnceLock<Value> = OnceLock::new();
    PARSERS
        .get_or_init(|| serde_json::from_str(include_str!("../compat/tool-parsers.json")).unwrap())
}

#[cfg(test)]
static REGEX_COMPILATIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn regexes() -> &'static HashMap<String, regex::Regex> {
    static REGEXES: OnceLock<HashMap<String, regex::Regex>> = OnceLock::new();
    REGEXES.get_or_init(|| {
        fn collect(schema: &Value, compiled: &mut HashMap<String, regex::Regex>) {
            if text(schema, "check") == "string_format" {
                let source = text(&schema["pattern"], "source");
                compiled.entry(source.to_owned()).or_insert_with(|| {
                    #[cfg(test)]
                    REGEX_COMPILATIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    regex::Regex::new(source).expect("captured MCP regex")
                });
            }
            match schema {
                Value::Object(values) => values.values().for_each(|value| collect(value, compiled)),
                Value::Array(values) => values.iter().for_each(|value| collect(value, compiled)),
                _ => {}
            }
        }
        let mut compiled = HashMap::new();
        // Only captured schemas supply patterns; request values never grow this cache.
        collect(parsers(), &mut compiled);
        collect(envelopes(), &mut compiled);
        compiled
    })
}

pub fn parse(name: &str, input: Value) -> std::result::Result<Value, String> {
    let Some(schema) = parsers().get(name) else {
        return Err(format!("MCP error -32602: Tool {name} not found"));
    };
    let (value, issues) = check(schema, Some(&input), &[]);
    if issues.is_empty() {
        Ok(value)
    } else {
        Err(format!(
            "MCP error -32602: Input validation error: Invalid arguments for tool {name}: {}",
            issues
                .iter()
                .map(|e| {
                    let mut path = String::new();
                    for part in e["path"].as_array().unwrap() {
                        if let Some(index) = part.as_u64() {
                            path.push_str(&format!("[{index}]"));
                        } else {
                            if !path.is_empty() {
                                path.push('.');
                            }
                            path.push_str(part.as_str().unwrap());
                        }
                    }
                    if path.is_empty() {
                        text(e, "message").to_owned()
                    } else {
                        format!("{} at {path}", text(e, "message"))
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        ))
    }
}
fn envelopes() -> &'static Value {
    static PARSERS: OnceLock<Value> = OnceLock::new();
    PARSERS
        .get_or_init(|| serde_json::from_str(include_str!("../compat/tool-envelope.json")).unwrap())
}
pub fn message_valid(input: &Value) -> bool {
    check(&envelopes()["message"], Some(input), &[])
        .1
        .is_empty()
}
pub fn is_initialize(input: &Value) -> bool {
    check(&envelopes()["initialize"], Some(input), &[])
        .1
        .is_empty()
}
pub fn envelope(input: &Value) -> Option<(u16, Value)> {
    let parsers = envelopes();
    if !check(&parsers["request"], Some(input), &[]).1.is_empty() {
        return Some((
            400,
            json!({"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error: Invalid JSON-RPC message"},"id":null}),
        ));
    }
    let schema = match input["method"].as_str() {
        Some("tools/call") => "call",
        Some("tools/list") => "list",
        Some("initialize") => "initialize",
        Some("ping") => "ping",
        _ => {
            return Some((
                200,
                json!({"jsonrpc":"2.0","id":input["id"],"error":{"code":-32601,"message":"Method not found"}}),
            ));
        }
    };
    let error = if schema == "call"
        && input["params"]["task"].is_object()
        && check(&parsers["task"], input.get("params"), &[])
            .1
            .is_empty()
    {
        Some(
            json!({"code":-32603,"message":"Server does not support task creation (required for tools/call)"}),
        )
    } else {
        let (_, issues) = check(&parsers[schema], Some(input), &[]);
        if issues.is_empty() {
            None
        } else {
            Some(json!({"code":-32603,"message":formatted_issues(&issues)}))
        }
    };
    error.map(|error| (200, json!({"jsonrpc":"2.0","id":input["id"],"error":error})))
}
fn formatted_issues(issues: &Vec<Issue>) -> String {
    // Zod embeds JSON.stringify output in another JSON message string.
    let pretty = serde_json::to_string_pretty(issues).unwrap();
    let wire = crate::js_string::utf16_json(&crate::js_string::units(&pretty)).unwrap();
    crate::js_string::encode(&wire)
}
pub fn normalized_envelope(input: &Value) -> Value {
    let schema = match input["method"].as_str() {
        Some("tools/call") => "call",
        Some("tools/list") => "list",
        Some("initialize") => "initialize",
        Some("ping") => "ping",
        _ => return input.clone(),
    };
    let (mut value, issues) = check(&envelopes()[schema], Some(input), &[]);
    debug_assert!(issues.is_empty());
    value["jsonrpc"] = input["jsonrpc"].clone();
    value["id"] = input["id"].clone();
    // These client features are accepted by the legacy SDK but unused by our
    // tools. Avoid interpreting them through a newer SDK's capability types.
    if schema == "initialize" {
        value["params"]["capabilities"] = json!({});
    }
    value
}
// Zod keeps continuation on internal issues, then removes it when formatting.
// Keep that control state separate so nested union diagnostics retain public JSON.
#[derive(Clone)]
struct Issue {
    value: Value,
    continuation: Option<bool>,
}
impl std::ops::Deref for Issue {
    type Target = Value;
    fn deref(&self) -> &Value {
        &self.value
    }
}
impl serde::Serialize for Issue {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.value.serialize(serializer)
    }
}
impl Issue {
    fn checked(mut self, check: &Value) -> Self {
        self.continuation = Some(check["abort"] != true);
        self
    }
}
fn issue(mut value: Value, path: &[Value], message: String) -> Issue {
    value["path"] = json!(path);
    value["message"] = json!(message);
    Issue {
        value,
        continuation: None,
    }
}
fn bound_issue(kind: &str, big: bool, length: bool, bound: &Value, path: &[Value]) -> Issue {
    let mut error = json!({"origin":kind,"code":if big {"too_big"} else {"too_small"}});
    error[if big { "maximum" } else { "minimum" }] = bound.clone();
    error["inclusive"] = json!(true);
    let predicate = if length {
        format!(
            "to have {}{bound} {}",
            if big { "<=" } else { ">=" },
            if kind == "string" {
                "characters"
            } else {
                "items"
            }
        )
    } else {
        format!("to be {}{bound}", if big { "<=" } else { ">=" })
    };
    issue(
        error,
        path,
        format!(
            "Too {}: expected {kind} {predicate}",
            if big { "big" } else { "small" }
        ),
    )
}
fn received(v: Option<&Value>) -> &'static str {
    match v {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}
fn child_path(path: &[Value], key: Value) -> Vec<Value> {
    let mut p = path.to_vec();
    p.push(key);
    p
}
fn check(s: &Value, v: Option<&Value>, path: &[Value]) -> (Value, Vec<Issue>) {
    let kind = text(s, "type");
    match kind {
        "assert_object" => {
            return if v.is_some_and(|v| v.is_object() || v.is_array()) {
                (v.unwrap().clone(), vec![])
            } else {
                (
                    Value::Null,
                    vec![issue(json!({"code":"custom"}), path, "Invalid input".into()).checked(s)],
                )
            };
        }
        "elicitation" => {
            let normalized = if v.is_some_and(|v| v.as_object().is_some_and(|m| m.is_empty())) {
                Some(json!({"form":{}}))
            } else {
                v.cloned()
            };
            return check(&s["schema"], normalized.as_ref(), path);
        }
        "intersection" => {
            let (mut left, mut errors) = check(&s["left"], v, path);
            let (right, e) = check(&s["right"], v, path);
            errors.extend(e);
            if errors.is_empty()
                && let (Some(left), Some(right)) = (left.as_object_mut(), right.as_object())
            {
                left.extend(right.clone());
            }
            return (left, errors);
        }
        "unknown" | "any" => return (v.cloned().unwrap_or(Value::Null), vec![]),
        "optional" if v.is_none() => return (Value::Null, vec![]),
        "optional" => return check(&s["inner"], v, path),
        "default" if v.is_none() => return (s["default"].clone(), vec![]),
        "default" => return check(&s["inner"], v, path),
        "union" => {
            let options = s["options"].as_array().unwrap();
            if let Some(d) = s["discriminator"].as_str() {
                if !v.is_some_and(Value::is_object) {
                    return (
                        Value::Null,
                        vec![issue(
                            json!({"code":"invalid_type","expected":"object"}),
                            path,
                            format!("Invalid input: expected object, received {}", received(v)),
                        )],
                    );
                }
                let tag = v.and_then(|v| v.get(d));
                if let Some(option) = options.iter().find(|o| {
                    o["shape"][d]["values"]
                        .as_array()
                        .is_some_and(|a| tag.is_some_and(|v| a.contains(v)))
                }) {
                    return check(option, v, path);
                }
                let values = options
                    .iter()
                    .flat_map(|o| o["shape"][d]["values"].as_array().unwrap().iter().cloned())
                    .collect::<Vec<_>>();
                let expected = values
                    .iter()
                    .map(|v| format!("'{}'", v.as_str().unwrap()))
                    .collect::<Vec<_>>()
                    .join(" | ");
                return (
                    Value::Null,
                    vec![issue(
                        json!({"code":"invalid_union","errors":[],"note":"No matching discriminator","discriminator":d,"options":values}),
                        &child_path(path, json!(d)),
                        format!("Invalid discriminator value. Expected {expected}"),
                    )],
                );
            }
            let mut results = vec![];
            for option in options {
                let result = check(option, v, &[]);
                if result.1.is_empty() {
                    return result;
                }
                results.push(result);
            }
            // handleUnionResults selects exactly one non-aborted result. A
            // nested union that made the same choice preserves continuation.
            let continuing = results
                .iter()
                .enumerate()
                .filter_map(|(index, (_, issues))| {
                    issues
                        .iter()
                        .all(|issue| issue.continuation == Some(true))
                        .then_some(index)
                })
                .collect::<Vec<_>>();
            if let [index] = continuing.as_slice() {
                let (out, mut issues) = results.swap_remove(*index);
                for issue in &mut issues {
                    let mut full_path = path.to_vec();
                    full_path.extend(issue["path"].as_array().unwrap().iter().cloned());
                    issue.value["path"] = json!(full_path);
                }
                return (out, issues);
            }
            let errors = results
                .into_iter()
                .map(|(_, issues)| issues)
                .collect::<Vec<_>>();
            return (
                Value::Null,
                vec![issue(
                    json!({"code":"invalid_union","errors":errors}),
                    path,
                    "Invalid input".into(),
                )],
            );
        }
        "enum" | "literal" => {
            let values = s["values"].as_array().unwrap();
            if v.is_some_and(|v| values.contains(v)) {
                return (v.unwrap().clone(), vec![]);
            }
            let quoted = values.iter().map(|v| v.to_string()).collect::<Vec<_>>();
            let message = if values.len() == 1 {
                format!("Invalid input: expected {}", quoted[0])
            } else {
                format!("Invalid option: expected one of {}", quoted.join("|"))
            };
            return (
                Value::Null,
                vec![issue(
                    json!({"code":"invalid_value","values":values}),
                    path,
                    message,
                )],
            );
        }
        _ => {}
    }
    if received(v) != if kind == "record" { "object" } else { kind } {
        return (
            Value::Null,
            vec![issue(
                json!({"expected":kind,"code":"invalid_type"}),
                path,
                format!("Invalid input: expected {kind}, received {}", received(v)),
            )],
        );
    }
    let mut out = v.unwrap().clone();
    let mut errors = vec![];
    if kind == "number" && out.as_f64().is_none() {
        let received = if out.to_string().starts_with('-') {
            "-Infinity"
        } else {
            "Infinity"
        };
        return (
            out,
            vec![issue(
                json!({"expected":"number","code":"invalid_type","received":received}),
                path,
                format!("Invalid input: expected number, received {received}"),
            )],
        );
    }
    if kind == "record" {
        out.as_object_mut().unwrap().remove("__proto__");
        for (key, value) in out.as_object_mut().unwrap() {
            let (_, e) = check(&s["key"], Some(&json!(key)), &child_path(path, json!(key)));
            errors.extend(e);
            let (parsed, e) = check(&s["value"], Some(value), &child_path(path, json!(key)));
            *value = parsed;
            errors.extend(e);
        }
    } else if kind == "object" {
        let mut result = serde_json::Map::new();
        let object = out.as_object().unwrap();
        for (key, schema) in s["shape"].as_object().unwrap() {
            let (value, e) = check(schema, object.get(key), &child_path(path, json!(key)));
            errors.extend(e);
            if object.contains_key(key) || text(schema, "type") == "default" {
                result.insert(key.clone(), value);
            }
        }
        let unknown = object
            .keys()
            .filter(|k| s["shape"].get(*k).is_none())
            .cloned()
            .collect::<Vec<_>>();
        if s["strict"] == true && !unknown.is_empty() {
            let suffix = if unknown.len() == 1 { "" } else { "s" };
            let mut unknown_keys = issue(
                json!({"code":"unrecognized_keys","keys":unknown}),
                path,
                format!(
                    "Unrecognized key{suffix}: {}",
                    unknown
                        .iter()
                        .map(|s| crate::js_string::encode(&crate::js_string::quote(s)))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            );
            unknown_keys.continuation = Some(true);
            errors.push(unknown_keys);
        }
        out = Value::Object(result);
    } else if kind == "array" {
        // Zod caps oversized containers before visiting their elements.
        if let Some(cap) = s["checks"].as_array().into_iter().flatten().find(|c| {
            text(c, "check") == "max_length"
                && out.as_array().unwrap().len() as u64 > c["maximum"].as_u64().unwrap()
        }) {
            return (
                out,
                vec![bound_issue("array", true, true, &cap["maximum"], path).checked(cap)],
            );
        }
        for (i, value) in out.as_array_mut().unwrap().iter_mut().enumerate() {
            let (parsed, e) = check(&s["element"], Some(value), &child_path(path, json!(i)));
            *value = parsed;
            errors.extend(e);
        }
    }
    for c in s["checks"].as_array().into_iter().flatten() {
        let aborted = errors.iter().any(|issue| issue.continuation != Some(true));
        let explicit = errors.iter().any(|issue| issue.continuation == Some(false));
        // Captured length checks have Zod's built-in `when`, which runs through
        // implicit type errors but still respects an explicit aborting check.
        let length_check = matches!(text(c, "check"), "min_length" | "max_length");
        if aborted && (!length_check || explicit) {
            continue;
        }
        match text(c, "check") {
            "overwrite" => {
                if let Some(value) = out.as_str() {
                    out = json!(value.trim_matches(js_whitespace));
                }
            }
            "number_format" => {
                let n = out.as_f64().unwrap();
                if n.fract() != 0.0 {
                    let mut invalid = issue(
                        json!({"expected":"int","format":"safeint","code":"invalid_type"}),
                        path,
                        "Invalid input: expected int, received number".into(),
                    );
                    invalid.continuation = Some(false);
                    errors.push(invalid);
                    break;
                }
                if n.abs() > 9_007_199_254_740_991.0 {
                    let big = n > 0.0;
                    let bound = if big {
                        9_007_199_254_740_991i64
                    } else {
                        -9_007_199_254_740_991i64
                    };
                    let mut e = json!({"code":if big{"too_big"}else{"too_small"}});
                    e[if big { "maximum" } else { "minimum" }] = json!(bound);
                    e["note"] = json!("Integers must be within the safe integer range.");
                    e["origin"] = json!("int");
                    e["inclusive"] = json!(true);
                    errors.push(
                        issue(
                            e,
                            path,
                            format!(
                                "Too {}: expected int to be {}{bound}",
                                if big { "big" } else { "small" },
                                if big { "<=" } else { ">=" }
                            ),
                        )
                        .checked(c),
                    );
                }
            }
            "min_length" | "max_length" | "greater_than" | "less_than" => {
                let big = ["max_length", "less_than"].contains(&text(c, "check"));
                let length = ["max_length", "min_length"].contains(&text(c, "check"));
                let bound = if length {
                    &c[if big { "maximum" } else { "minimum" }]
                } else {
                    &c["value"]
                };
                let n = if kind == "string" {
                    crate::js_string::count(out.as_str().unwrap()) as f64
                } else if kind == "array" {
                    out.as_array().unwrap().len() as f64
                } else {
                    out.as_f64().unwrap()
                };
                if if big {
                    n > bound.as_f64().unwrap()
                } else {
                    n < bound.as_f64().unwrap()
                } {
                    errors.push(bound_issue(kind, big, length, bound, path).checked(c));
                }
            }
            "string_format" => {
                let pattern = text(&c["pattern"], "source");
                if !regexes()
                    .get(pattern)
                    .expect("pattern belongs to captured MCP schemas")
                    .is_match(out.as_str().unwrap())
                {
                    let display = text(&c["pattern"], "display");
                    errors.push(issue(json!({"origin":"string","code":"invalid_format","format":"regex","pattern":display}),path,format!("Invalid string: must match pattern {display}")).checked(c));
                }
            }
            _ => {}
        }
    }
    (out, errors)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maximum_choice_forms_reuse_captured_regexes() {
        let input = json!({
            "title":"Synthetic form", "body":"Choose one option per field", "idempotencyKey":"regex-cache",
            "fields":(0..30).map(|i| json!({"id":format!("field{i}"),"label":"Choose","type":"single_choice",
                "options":(0..40).map(|j| json!({"id":format!("option{j}"),"label":"Option"})).collect::<Vec<_>>()
            })).collect::<Vec<_>>(),
            "actions":[{"id":"send","label":"Send","type":"submit"}]
        });
        assert!(crate::model::js_json(&input, false).len() < 256 * 1024);
        parse("create_request", input.clone()).unwrap();
        let compiled = REGEX_COMPILATIONS.load(std::sync::atomic::Ordering::SeqCst);
        assert_eq!(compiled, regexes().len());
        for _ in 0..3 {
            parse("create_request", input.clone()).unwrap();
        }
        assert_eq!(
            REGEX_COMPILATIONS.load(std::sync::atomic::Ordering::SeqCst),
            compiled
        );
        let mut invalid = input;
        invalid["fields"][29]["options"][39]["id"] = json!("invalid identifier");
        assert!(
            parse("create_request", invalid)
                .unwrap_err()
                .contains("Invalid string: must match pattern")
        );
        assert_eq!(
            REGEX_COMPILATIONS.load(std::sync::atomic::Ordering::SeqCst),
            compiled
        );
    }
    #[test]
    fn captured_check_abort_flag_changes_union_eligibility() {
        let mut schema = parsers()["create_request"]["shape"]["steps"]["inner"]["element"]["shape"]
            ["when"]["inner"]
            .clone();
        let input = json!({"fieldId":"f","contains":"?"});
        let (_, issues) = check(&schema, Some(&input), &[]);
        assert_eq!(issues[0]["code"], "invalid_format");
        schema["options"][1]["shape"]["contains"]["checks"][0]["abort"] = json!(true);
        let (_, issues) = check(&schema, Some(&input), &[]);
        assert_eq!(issues[0]["code"], "invalid_union");
        assert_eq!(issues[0]["errors"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn captured_sdk_validation() {
        let initialization: Value =
            serde_json::from_str(include_str!("../compat/initialization-validation.json")).unwrap();
        for case in initialization.as_array().unwrap() {
            let (_, issues) = check(&envelopes()["initialize"], Some(&case["input"]), &[]);
            assert_eq!(
                issues.is_empty(),
                case["valid"] == true,
                "{}",
                case["input"]
            );
            if !issues.is_empty() {
                assert_eq!(formatted_issues(&issues), case["error"].as_str().unwrap());
            }
        }
        let cases: Value =
            serde_json::from_str(include_str!("../compat/tool-validation.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let schema = if let Some(name) = case["envelope"].as_str() {
                envelopes()[name].clone()
            } else {
                parsers()[text(case, "name")].clone()
            };
            let (_, issues) = check(&schema, Some(&case["input"]), &[]);
            if let Some(expected) = case.get("issues") {
                assert_eq!(
                    serde_json::to_value(&issues).unwrap(),
                    *expected,
                    "{}",
                    case["input"]
                );
                // Also pin JSON field order used by SDK envelope diagnostics.
                assert_eq!(
                    formatted_issues(&issues),
                    serde_json::to_string_pretty(expected).unwrap()
                );
            }
            if case.get("name").is_none() {
                continue;
            }
            let result = parse(text(case, "name"), case["input"].clone());
            if let Some(error) = case["error"].as_str() {
                assert_eq!(result.unwrap_err(), error, "{}", case["input"]);
            } else {
                assert_eq!(result.unwrap(), case["value"]);
            }
        }
    }
}
