use request_relay_client::Client;
use serde_json::json;
#[test]
fn private_process_transport(){
 let client=Client{broker:format!("{}/../../scripts/sdk-broker-fixture.py",env!("CARGO_MANIFEST_DIR")),profile:"conformance".into(),..Default::default()};
 assert_eq!(client.status(json!({}),Some("public-connection")).unwrap()["setup"],"setup_complete");
 assert_eq!(client.request_sms(json!({}),Some("public-connection")).unwrap_err().to_string(),"sms_approval_required");
}
