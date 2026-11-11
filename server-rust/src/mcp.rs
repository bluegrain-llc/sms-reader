use crate::{
    error::Error,
    model::*,
    relay::{Auth, Relay},
};
use rmcp::{RoleServer, ServerHandler, model::*, service::RequestContext};
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    sync::{Arc, OnceLock},
};
#[derive(Clone)]
pub struct Mcp {
    pub relay: Relay,
    pub secret: String,
}
pub fn tools() -> Vec<Tool> {
    static TOOLS: OnceLock<Vec<Tool>> = OnceLock::new();
    TOOLS
        .get_or_init(|| serde_json::from_str(include_str!("../compat/tools.json")).unwrap())
        .clone()
}
impl ServerHandler for Mcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_tool_list_changed()
                .build(),
        )
        .with_server_info(Implementation::new("sms-code-relay", "0.6.0"))
        .with_protocol_version(ProtocolVersion::V_2025_11_25)
    }
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Owned(
            VERSIONS
                .iter()
                .map(|v| serde_json::from_value(json!(v)).unwrap())
                .collect(),
        )
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, rmcp::ErrorData> {
        let relay = self.relay.clone();
        let secret = self.secret.clone();
        let g = self
            .relay
            .store
            .tx(move |tx| {
                let (r, k) = (relay.clone(), secret.clone());
                Box::pin(async move { Ok(r.agent(tx, &k).await?.0) })
            })
            .await
            .map_err(|_| rmcp::ErrorData::invalid_request("invalid_token", None))?;
        Ok(ListToolsResult::with_all_items(
            tools()
                .into_iter()
                .filter(|tool| {
                    g.get("capabilities").is_none()
                        || crate::onboarding::capability(
                            &g,
                            if [
                                "request_sms_code",
                                "get_sms_code_request",
                                "cancel_sms_code_request",
                            ]
                            .contains(&tool.name.as_ref())
                            {
                                "sms"
                            } else {
                                "forms"
                            },
                        )
                })
                .collect(),
        ))
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, rmcp::ErrorData> {
        let input = Value::Object(request.arguments.unwrap_or_default());
        let input = match crate::mcp_input::parse(&request.name, input) {
            Ok(input) => input,
            Err(message) => {
                let mut out = CallToolResult::error(vec![ContentBlock::text(message)]);
                out.result_type = None;
                return Ok(out.into());
            }
        };
        let key = self.secret.clone();
        let relay = &self.relay;
        let result = async {
            let rid = || -> crate::error::Result<String> {
                id(text(&input, "requestId"))?;
                Ok(text(&input, "requestId").into())
            };
            match request.name.as_ref() {
                "request_sms_code" => relay.create(key, input.clone()).await,
                "get_sms_code_request" => relay.get(key, rid()?).await,
                "cancel_sms_code_request" => {
                    relay
                        .transition(Auth::Agent(key), rid()?, json!({"status":"cancelled"}))
                        .await
                }
                "create_request" => relay.form_create(key, input.clone()).await,
                "inspect_request" => relay.form_get(Auth::Agent(key), rid()?).await,
                "cancel_request" => relay.form_cancel(key, rid()?).await,
                "get_request_result" => relay.form_result(key, rid()?).await,
                "poll_request_events" => {
                    let cursor = input
                        .get("cursor")
                        .map(|_| string(&input, "cursor", 0, 128, false))
                        .transpose()?;
                    relay.events(key, cursor).await
                }
                _ => Err(Error::Api(400, "unknown_tool")),
            }
        }
        .await;
        let result = match result {
            Ok(v) => {
                let mut out = CallToolResult::success(vec![ContentBlock::text(
                    crate::js_string::encode(&js_json(&v, false)),
                )]);
                out.structured_content = Some(v);
                out.is_error = None;
                out.result_type = None;
                out
            }
            Err(e) => {
                if !matches!(&e, Error::Api(_, _)) {
                    relay
                        .delivery
                        .emit("mcp_tool_failed", crate::telemetry::category(&e))
                        .await;
                }
                let reason = match e {
                    Error::Api(_, r) => r,
                    _ => "internal_error",
                };
                let mut out = CallToolResult::error(vec![ContentBlock::text(
                    json!({"error":reason}).to_string(),
                )]);
                out.result_type = None;
                out
            }
        };
        Ok(result.into())
    }
}
const VERSIONS: [&str; 5] = [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];
fn rpc_response(value: Value, status: u16) -> axum::response::Response {
    let mut response = crate::http::json_response(value, status);
    response
        .headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    response
}
fn transport_error(status: u16, code: i32, message: impl Into<String>) -> axum::response::Response {
    rpc_response(
        json!({"jsonrpc":"2.0","error":{"code":code,"message":message.into()},"id":null}),
        status,
    )
}
pub async fn handle(
    relay: Relay,
    secret: String,
    request: axum::extract::Request,
    envelope: Value,
) -> axum::response::Response {
    let mut headers = request.headers().clone();
    let accept = headers
        .get("accept")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !accept.contains("application/json") || !accept.contains("text/event-stream") {
        return transport_error(
            406,
            -32000,
            "Not Acceptable: Client must accept both application/json and text/event-stream",
        );
    }
    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !content_type
        .split(';')
        .next()
        .unwrap()
        .trim()
        .eq_ignore_ascii_case("application/json")
    {
        return transport_error(
            415,
            -32000,
            "Unsupported Media Type: Content-Type must be application/json",
        );
    }
    let messages = match envelope {
        Value::Array(messages) => messages,
        message => vec![message],
    };
    if messages.len() > 100 {
        return transport_error(
            400,
            -32600,
            "Invalid Request: Batch must not exceed 100 messages",
        );
    }
    if !messages.iter().all(crate::mcp_input::message_valid) {
        return transport_error(400, -32700, "Parse error: Invalid JSON-RPC message");
    }
    let initialize = messages.iter().any(crate::mcp_input::is_initialize);
    if initialize && messages.len() > 1 {
        return transport_error(
            400,
            -32600,
            "Invalid Request: Only one initialization request is allowed",
        );
    }
    if !initialize
        && let Some(version) = headers
            .get("mcp-protocol-version")
            .and_then(|v| v.to_str().ok())
        && !VERSIONS.contains(&version)
    {
        return transport_error(
            400,
            -32000,
            format!(
                "Bad Request: Unsupported protocol version: {version} (supported versions: {})",
                VERSIONS.join(", ")
            ),
        );
    }
    // Header validation above follows the existing transport. Its oldest version
    // predates the Rust SDK's transport list; negotiation remains in the handler.
    headers.insert(
        "accept",
        "application/json, text/event-stream".parse().unwrap(),
    );
    headers.insert("content-type", "application/json".parse().unwrap());
    headers.remove("content-length");
    headers.remove("mcp-session-id");
    headers.remove("mcp-protocol-version");
    let responses = futures::future::join_all(
        messages
            .into_iter()
            .filter(|m| m.get("method").is_some() && m.get("id").is_some())
            .map(|message| run_sdk(relay.clone(), secret.clone(), headers.clone(), message)),
    )
    .await;
    let responses = responses.into_iter().flatten().collect::<Vec<_>>();
    match responses.len() {
        0 => axum::response::Response::builder()
            .status(202)
            .body(axum::body::Body::empty())
            .unwrap(),
        1 => rpc_response(responses.into_iter().next().unwrap(), 200),
        _ => rpc_response(Value::Array(responses), 200),
    }
}
async fn run_sdk(
    relay: Relay,
    secret: String,
    headers: axum::http::HeaderMap,
    mut envelope: Value,
) -> Option<Value> {
    use rmcp::transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    };
    use tower::ServiceExt;
    if let Some((_, error)) = crate::mcp_input::envelope(&envelope) {
        return Some(error);
    }
    envelope = crate::mcp_input::normalized_envelope(&envelope);
    let original_id = envelope["id"].clone();
    let list_tools = envelope["method"] == "tools/list";
    if original_id.as_i64().is_some_and(|n| n < 0) {
        envelope["id"] = json!("compat-negative-id");
    }
    let body = serde_json::to_vec(&envelope).unwrap();
    let limit = body.len().max(256 * 1024);
    let mut request = axum::extract::Request::builder()
        .method("POST")
        .uri("/mcp")
        .body(axum::body::Body::from(body))
        .unwrap();
    *request.headers_mut() = headers;
    let service = StreamableHttpService::new(
        move || {
            Ok(Mcp {
                relay: relay.clone(),
                secret: secret.clone(),
            })
        },
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true)
            .with_max_request_body_bytes(limit)
            .disable_allowed_hosts()
            .disable_allowed_origins(),
    );
    let response = service.oneshot(request).await.unwrap();
    let bytes = axum::body::to_bytes(axum::body::Body::new(response.into_body()), usize::MAX)
        .await
        .unwrap();
    let mut value = serde_json::from_slice::<Value>(&bytes).ok()?;
    if list_tools && value["result"]["tools"].is_array() {
        let allowed = value["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        static WIRE_TOOLS: OnceLock<Value> = OnceLock::new();
        value["result"]["tools"] = WIRE_TOOLS
            .get_or_init(|| serde_json::from_str(include_str!("../compat/tools.json")).unwrap())
            .clone();
        value["result"]["tools"]
            .as_array_mut()
            .unwrap()
            .retain(|t| allowed.iter().any(|name| t["name"] == name.as_str()));
    }
    if value["id"] == "compat-negative-id" {
        value["id"] = original_id;
    }
    Some(value)
}
