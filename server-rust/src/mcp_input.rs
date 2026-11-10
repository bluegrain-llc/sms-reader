//! Captured Zod input semantics used by the existing MCP SDK registration.
use crate::model::{js_whitespace, text};
use serde_json::{Value, json};
use std::sync::OnceLock;

pub fn parse(name: &str, input: Value) -> std::result::Result<Value, String> {
    static PARSERS: OnceLock<Value> = OnceLock::new();
    let parsers = PARSERS
        .get_or_init(|| serde_json::from_str(include_str!("../compat/tool-parsers.json")).unwrap());
    let Some(schema) = parsers.get(name) else {
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
fn issue(mut value: Value, path: &[Value], message: String) -> Value {
    value["path"] = json!(path);
    value["message"] = json!(message);
    value
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
fn check(s: &Value, v: Option<&Value>, path: &[Value]) -> (Value, Vec<Value>) {
    let kind = text(s, "type");
    match kind {
        "optional" if v.is_none() => return (Value::Null, vec![]),
        "optional" => return check(&s["inner"], v, path),
        "default" if v.is_none() => return (s["default"].clone(), vec![]),
        "default" => return check(&s["inner"], v, path),
        "union" => {
            let options = s["options"].as_array().unwrap();
            if let Some(d) = s["discriminator"].as_str() {
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
            let mut errors = vec![];
            for option in options {
                let (out, e) = check(option, v, &[]);
                if e.is_empty() {
                    return (out, e);
                }
                errors.push(e);
            }
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
    if received(v) != kind {
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
    if kind == "object" {
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
            errors.push(issue(
                json!({"code":"unrecognized_keys","keys":unknown}),
                path,
                format!(
                    "Unrecognized key{suffix}: {}",
                    unknown
                        .iter()
                        .map(|s| json!(s).to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ));
        }
        out = Value::Object(result);
    } else if kind == "array" {
        for (i, value) in out.as_array_mut().unwrap().iter_mut().enumerate() {
            let (parsed, e) = check(&s["element"], Some(value), &child_path(path, json!(i)));
            *value = parsed;
            errors.extend(e);
        }
    }
    for c in s["checks"].as_array().into_iter().flatten() {
        match text(c, "check") {
            "overwrite" => {
                if let Some(value) = out.as_str() {
                    out = json!(value.trim_matches(js_whitespace));
                }
            }
            "number_format" => {
                let n = out.as_f64().unwrap();
                if n.fract() != 0.0 {
                    errors.push(issue(
                        json!({"expected":"int","format":"safeint","code":"invalid_type"}),
                        path,
                        "Invalid input: expected int, received number".into(),
                    ));
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
                    errors.push(issue(
                        e,
                        path,
                        format!(
                            "Too {}: expected int to be {}{bound}",
                            if big { "big" } else { "small" },
                            if big { "<=" } else { ">=" }
                        ),
                    ));
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
                    out.as_str().unwrap().chars().count() as f64
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
                    let mut e = json!({"origin":kind,"code":if big{"too_big"}else{"too_small"}});
                    e[if big { "maximum" } else { "minimum" }] = bound.clone();
                    e["inclusive"] = json!(true);
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
                    errors.push(issue(
                        e,
                        path,
                        format!(
                            "Too {}: expected {kind} {predicate}",
                            if big { "big" } else { "small" }
                        ),
                    ));
                }
            }
            "string_format" => {
                let pattern = text(&c["pattern"], "source");
                if !regex::Regex::new(pattern)
                    .unwrap()
                    .is_match(out.as_str().unwrap())
                {
                    let display = text(&c["pattern"], "display");
                    errors.push(issue(json!({"origin":"string","code":"invalid_format","format":"regex","pattern":display}),path,format!("Invalid string: must match pattern {display}")));
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
    fn captured_sdk_validation() {
        let cases: Value =
            serde_json::from_str(include_str!("../compat/tool-validation.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let result = parse(text(case, "name"), case["input"].clone());
            if let Some(error) = case["error"].as_str() {
                assert_eq!(result.unwrap_err(), error, "{}", case["input"]);
            } else {
                assert_eq!(result.unwrap(), case["value"]);
            }
        }
    }
}
