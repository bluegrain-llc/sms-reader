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
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("sms-code-relay", "0.6.0"))
            .with_protocol_version(ProtocolVersion::V_2025_11_25)
    }
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Owned(
            [
                "2025-11-25",
                "2025-06-18",
                "2025-03-26",
                "2024-11-05",
                "2024-10-07",
            ]
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
        Ok(ListToolsResult::with_all_items(tools()))
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
pub async fn handle(
    relay: Relay,
    secret: String,
    request: axum::extract::Request,
    envelope: Value,
) -> axum::response::Response {
    use rmcp::transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    };
    use tower::ServiceExt;
    if envelope.get("id").is_some()
        && let Some((status, error)) = crate::mcp_input::envelope(&envelope)
    {
        return crate::http::json_response(error, status);
    }
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
            .with_max_request_body_bytes(
                (256 * 1024).max(serde_json::to_vec(&envelope).unwrap().len()),
            )
            .disable_allowed_hosts()
            .disable_allowed_origins(),
    );
    let response = service.oneshot(request).await.unwrap();
    let (mut parts, body) = response.into_parts();
    let bytes = axum::body::to_bytes(axum::body::Body::new(body), usize::MAX)
        .await
        .unwrap();
    let body = serde_json::from_slice::<Value>(&bytes)
        .map(|v| js_json(&v, false).into_bytes())
        .unwrap_or_else(|_| bytes.to_vec());
    parts.headers.remove(axum::http::header::CONTENT_LENGTH);
    axum::response::Response::from_parts(parts, axum::body::Body::from(body))
}
