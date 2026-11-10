use serde_json::{Value, json};
use sms_code_relay::{forms_model::*, model::*, webhooks::*};
#[test]
fn secrets_requests_and_codes() {
    let token = secret();
    assert!(valid_secret(&token));
    assert_eq!(hash(&token).len(), 64);
    assert_ne!(token, secret());
    for code_value in ["0000", "123456", "A1b2C3", "AB12345678"] {
        assert!(code(code_value));
    }
    for code_value in [
        "123",
        "12345678901",
        "letters",
        "A1-234",
        " 1234",
        "１２３４",
    ] {
        assert!(!code(code_value));
    }
    for v in [
        json!({"purpose":"ok","idempotencyKey":"test-key-1","deviceId":"arbitrary"}),
        json!({"purpose":"","idempotencyKey":"test-key-1"}),
        json!({"purpose":"ok","idempotencyKey":"test-key-1","senderPhone":"local"}),
    ] {
        assert!(sms_input(&v).is_err());
    }
}
#[test]
fn rate_boundary() {
    let rate = json!({"start":1000,"count":3});
    assert!(bump(&rate, 1000 + 10 * MINUTE - 1, 3).is_err());
    assert_eq!(
        bump(&rate, 1000 + 10 * MINUTE, 3).unwrap(),
        json!({"start":1000+10*MINUTE,"count":1})
    );
}
fn def() -> Value {
    definition(json!({"title":"Invoice","body":"Please review","idempotencyKey":"invoice-001","fields":[{"id":"note","label":"Note","type":"text","required":true,"maxLength":10},{"id":"amount","label":"Amount","type":"number","min":1,"max":100},{"id":"check","label":"Confirmed","type":"checkbox","required":true},{"id":"date","label":"Date","type":"date"},{"id":"category","label":"Category","type":"single_choice","options":[{"id":"food","label":"Food"}]},{"id":"tags","label":"Tags","type":"multiple_choice","options":[{"id":"tax","label":"Tax"}]}],"actions":[{"id":"yes","label":"Approve","type":"approve"},{"id":"no","label":"Decline","type":"decline"}]})).unwrap()
}
fn upload() -> Value {
    json!({"submissionId":"upload-1","action":"yes","values":{"note":"Okay","amount":50,"check":true,"date":"2026-11-09","category":"food","tags":["tax"]}})
}
#[test]
fn bounded_definitions() {
    let d = def();
    assert_eq!(d["expiresInSeconds"], 86400);
    for patch in [
        json!({"fields":[d["fields"][0].clone(),d["fields"][0].clone()]}),
        json!({"actions":[d["actions"][0].clone(),d["actions"][0].clone()]}),
        json!({"expiresInSeconds":604801}),
        json!({"fields":[{"id":"a","type":"number","label":"n","min":5,"max":1}]}),
        json!({"script":"alert(1)"}),
        json!({"fields":[{"id":"a","type":"single_choice","label":"Choice","options":[{"id":"a","label":"A"},{"id":"a","label":"Again"}]}]}),
    ] {
        let mut v = d.clone();
        v.as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        assert!(definition(v).is_err());
    }
}
#[test]
fn typed_submissions() {
    let d = def();
    assert_eq!(validate_submission(&d, &upload()).unwrap(), "submitted");
    assert_eq!(
        validate_submission(
            &d,
            &json!({"submissionId":"decline-1","action":"no","values":{}})
        )
        .unwrap(),
        "declined"
    );
    for patch in [
        json!({"note":""}),
        json!({"note":"longlonglonglong"}),
        json!({"amount":"20"}),
        json!({"amount":0}),
        json!({"check":false}),
        json!({"check":"true"}),
        json!({"date":"2026-02-30"}),
        json!({"date":"2026-11-09T12:00Z"}),
        json!({"category":"unknown"}),
        json!({"tags":["tax","tax"]}),
        json!({"tags":["unknown"]}),
        json!({"surprise":"x"}),
    ] {
        let mut u = upload();
        u["values"]
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        assert!(validate_submission(&d, &u).is_err(), "{patch}");
    }
}
#[test]
fn sms_helpers_validate() {
    let mut d = def();
    d["fields"] =
        json!([{"id":"code","label":"Code","type":"text","input":"sms_code","required":true}]);
    let d = definition(d).unwrap();
    for (value, ok) in [("A1234", true), ("letters", false)] {
        assert_eq!(
            validate_submission(
                &d,
                &json!({"submissionId":"sms-helper","action":"yes","values":{"code":value}})
            )
            .is_ok(),
            ok
        );
    }
}
#[test]
fn public_addresses() {
    for ip in [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "0.0.0.0",
        "100.64.0.1",
        "224.1.1.1",
        "::1",
        "::",
        "fe80::1",
        "fc00::1",
        "::ffff:127.0.0.1",
        "192.0.2.1",
        "198.18.0.1",
        "64:ff9b::7f00:1",
        "2002:7f00:1::",
    ] {
        assert!(!public_address(ip.parse().unwrap()), "{ip}");
    }
    for ip in ["8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"] {
        assert!(public_address(ip.parse().unwrap()));
    }
}
#[tokio::test]
async fn webhook_urls() {
    for url in [
        "http://8.8.8.8",
        "https://127.0.0.1",
        "https://[::1]",
        "https://user:pass@8.8.8.8",
        "https://8.8.8.8:8443",
        "https://8.8.8.8/#fragment",
    ] {
        assert!(destination(url).await.is_err());
    }
}
#[test]
fn signatures() {
    assert_eq!(
        signature("secret", "123", r#"{"id":"e"}"#),
        "856bedd896a4356b4737e395fcdeb19de5fca7c3ef02a02a2c55efc28fd547bc"
    );
    assert_ne!(
        signature("secret", "123", "body"),
        signature("secret", "124", "body")
    );
}
fn wizard() -> Value {
    definition(json!({"title":"Travel approval","body":"Complete steps","idempotencyKey":"wizard-001","fields":[{"id":"travel","type":"checkbox","label":"Travel expense"},{"id":"city","type":"text","label":"Destination","required":true},{"id":"receipt","type":"checkbox","label":"Receipt available"},{"id":"reference","type":"text","label":"Receipt reference","required":true}],"steps":[{"id":"kind","title":"Expense type","fieldIds":["travel"]},{"id":"trip","title":"Trip","fieldIds":["city","receipt"],"when":{"fieldId":"travel","equals":true}},{"id":"evidence","title":"Receipt","fieldIds":["reference"],"when":{"fieldId":"receipt","equals":true}}],"actions":[{"id":"submit","type":"submit","label":"Submit"},{"id":"decline","type":"decline","label":"Decline"}]})).unwrap()
}
#[test]
fn wizard_definition_constraints() {
    let d = wizard();
    let mut cases = vec![];
    for steps in [
        json!([d["steps"][0]]),
        json!([d["steps"][0], d["steps"][0]]),
    ] {
        let mut x = d.clone();
        x["steps"] = steps;
        cases.push(x);
    }
    for c in [
        json!({"fieldId":"reference","equals":"x"}),
        json!({"fieldId":"travel","equals":"true"}),
        json!({"fieldId":"travel","contains":"x"}),
    ] {
        let mut x = d.clone();
        x["steps"][1]["when"] = c;
        cases.push(x);
    }
    for x in cases {
        assert!(definition(x).is_err());
    }
}
#[test]
fn wizard_paths() {
    let d = wizard();
    for (values, ok) in [
        (json!({}), true),
        (json!({"travel":false}), true),
        (json!({"travel":true}), false),
        (
            json!({"travel":true,"city":"Santo Domingo","receipt":false}),
            true,
        ),
        (json!({"travel":true,"city":"City","receipt":true}), false),
        (
            json!({"travel":true,"city":"City","receipt":true,"reference":"DEMO"}),
            true,
        ),
        (
            json!({"travel":false,"city":"Stale","receipt":true,"reference":"Stale"}),
            false,
        ),
        (json!({"travel":false,"reference":"Stale"}), false),
    ] {
        assert_eq!(
            validate_submission(
                &d,
                &json!({"submissionId":"wizard-upload","action":"submit","values":values})
            )
            .is_ok(),
            ok,
            "{values}"
        );
    }
}
#[test]
fn wizard_numeric_conditions() {
    let mut d = wizard();
    d["fields"] = json!([{"id":"tags","type":"multiple_choice","label":"Tags","options":[{"id":"tax","label":"Tax"}]},{"id":"amount","type":"number","label":"Amount","required":true},{"id":"note","type":"text","label":"Note","required":true}]);
    d["steps"] = json!([{"id":"tags","title":"Tags","fieldIds":["tags"]},{"id":"tax","title":"Tax","fieldIds":["amount"],"when":{"fieldId":"tags","contains":"tax"}},{"id":"note","title":"Note","fieldIds":["note"],"when":{"fieldId":"amount","equals":10}}]);
    let d = definition(d).unwrap();
    for (values, ok) in [
        (json!({"tags":[]}), true),
        (json!({"tags":["tax"]}), false),
        (json!({"tags":["tax"],"amount":10}), false),
        (json!({"tags":["tax"],"amount":11}), true),
        (json!({"tags":["tax"],"amount":10,"note":"Test"}), true),
        (json!({"tags":["tax"],"amount":"10","note":"Test"}), false),
    ] {
        assert_eq!(
            validate_submission(
                &d,
                &json!({"submissionId":"choice-wizard","action":"submit","values":values})
            )
            .is_ok(),
            ok
        );
    }
}
#[test]
fn javascript_fixtures() {
    let fixtures: Value = serde_json::from_str(include_str!("../compat/hashes.json")).unwrap();
    for f in fixtures.as_array().unwrap() {
        assert_eq!(js_json(&f["input"], flag(f, "canonical")), text(f, "json"));
        assert_eq!(
            hash(&js_json(&f["input"], flag(f, "canonical"))),
            text(f, "hash")
        );
    }
    let s = "😀".repeat(4);
    assert!(sms_input(&json!({"purpose":"okay","idempotencyKey":s})).is_err());
    let s = "😀".repeat(8);
    assert!(sms_input(&json!({"purpose":"okay","idempotencyKey":s})).is_ok());
    let mut d = def();
    d["idempotencyKey"] = json!(s);
    assert!(definition(d).is_ok());
}

#[test]
fn javascript_whitespace_and_integral_numbers() {
    let v = sms_input(&json!({"purpose":"\u{0085}keep\u{0085}","idempotencyKey":"unicode-trim"}))
        .unwrap();
    assert_eq!(v["purpose"], "\u{0085}keep\u{0085}");
    let v = sms_input(&json!({"purpose":"\u{feff} trim \u{00a0}","idempotencyKey":"unicode-trim"}))
        .unwrap();
    assert_eq!(v["purpose"], "trim");
    let v: Value = serde_json::from_str("{\"value\":1.8e12}").unwrap();
    assert_eq!(num(&v, "value"), 1_800_000_000_000);
    assert_eq!(
        integer(&v, "value", 1, i64::MAX, None).unwrap(),
        1_800_000_000_000
    );
    assert!(
        integer(
            &json!({"value":9_007_199_254_740_992i64}),
            "value",
            1,
            i64::MAX,
            None
        )
        .is_err()
    );
}
