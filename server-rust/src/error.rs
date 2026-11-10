use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{1}")]
    Api(u16, &'static str),
    #[error("storage_failed")]
    Store(#[from] firestore::errors::FirestoreError),
    #[error("external_call_failed")]
    External,
    #[error("provider_failed")]
    Provider(&'static str),
}
pub type Result<T> = std::result::Result<T, Error>;
pub fn ensure(ok: bool, status: u16, reason: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(Error::Api(status, reason))
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, reason) = match self {
            Self::Api(s, r) => (s, r),
            _ => {
                eprintln!("request_failed");
                (500, "internal_error")
            }
        };
        let mut response = (
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(json!({"error":reason})),
        )
            .into_response();
        if status == 429 {
            response
                .headers_mut()
                .insert("Retry-After", "60".parse().unwrap());
        }
        response
    }
}
