use crate::{
    error::{Error, Result},
    http::Authentication,
    model::{num, text},
    relay::Relay,
    store::Query,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};

/// Log only registered route templates, never caller paths or query strings.
pub fn route_template(path: &str) -> &'static str {
    let path = path.trim_end_matches('/').to_ascii_lowercase();
    let parts = path.split('/').collect::<Vec<_>>();
    match parts.as_slice() {
        ["", "health" | "healthz"] => "/health",
        ["", "startup"] => "/startup",
        ["", ".well-known", "assetlinks.json"] => "/.well-known/assetlinks.json",
        ["", "connect"] => "/connect",
        ["", "privacy"] => "/privacy",
        ["", "account", "delete"] => "/account/delete",
        ["", "oauth", "consent", _] => "/oauth/consent/:id",
        ["", ".well-known", "oauth-authorization-server"] => {
            "/.well-known/oauth-authorization-server"
        }
        [
            "",
            ".well-known",
            "oauth-protected-resource",
            "mcp",
            "services",
            _,
        ] => "/.well-known/oauth-protected-resource/mcp/services/:id",
        ["", "oauth", "register"] => "/oauth/register",
        ["", "oauth", "authorize"] => "/oauth/authorize",
        ["", "oauth", "token"] => "/oauth/token",
        ["", "oauth", "revoke"] => "/oauth/revoke",
        ["", "v3", "oauth", "sessions", _] => "/v3/oauth/sessions/:id",
        ["", "v3", "oauth", "sessions", _, "decision"] => "/v3/oauth/sessions/:id/decision",
        ["", "v3", "oauth", "sessions", _, "response"] => "/v3/oauth/sessions/:id/response",
        ["", "mcp", "services", _] => "/mcp/services/:serviceId",
        ["", "owned-services"] => "/owned-services",
        ["", "owned-services.js"] => "/owned-services.js",
        ["", "onboarding-qr.js"] => "/onboarding-qr.js",
        ["", "onboarding.js"] => "/onboarding.js",
        ["", "register", _] => "/register/:id",
        ["", "pair", _] => "/pair/:id",
        ["", "services", _] => "/services/:id",
        ["", "connections", _] => "/connections/:id",
        ["", "v3", "registration-sessions"] => "/v3/registration-sessions",
        ["", "v3", "registration-sessions", "current"] => "/v3/registration-sessions/current",
        ["", "v3", "registration-sessions", _] => "/v3/registration-sessions/:id",
        ["", "v3", "registration-sessions", _, "decision"] => {
            "/v3/registration-sessions/:id/decision"
        }
        ["", "v3", "services"] => "/v3/services",
        ["", "v3", "services", _] => "/v3/services/:id",
        ["", "v3", "services", _, "connections"] => "/v3/services/:id/connections",
        ["", "v3", "service"] => "/v3/service",
        ["", "v3", "service", "pairing-sessions"] => "/v3/service/pairing-sessions",
        ["", "v3", "service", "pairing-sessions", _] => "/v3/service/pairing-sessions/:id",
        ["", "v3", "pairing-sessions", _] => "/v3/pairing-sessions/:id",
        ["", "v3", "pairing-sessions", _, "decision"] => "/v3/pairing-sessions/:id/decision",
        ["", "v3", "service", "deliveries"] => "/v3/service/deliveries",
        ["", "v3", "service", "deliveries", _, "acknowledgement"] => {
            "/v3/service/deliveries/:id/acknowledgement"
        }
        ["", "v3", "service", "connections", _] => "/v3/service/connections/:id",
        ["", "v3", "connection"] => "/v3/connection",
        ["", "v3", "connections", _] => "/v3/connections/:id",
        ["", "mcp"] => "/mcp",
        ["", "v1", "account"] => "/v1/account",
        ["", "v1", "account-deletion"] => "/v1/account-deletion",
        ["", "v1", "connections"] => "/v1/connections",
        ["", "v1", "connections", "poll"] => "/v1/connections/poll",
        ["", "v1", "connections", "review"] => "/v1/connections/review",
        ["", "v1", "connections", "decision"] => "/v1/connections/decision",
        ["", "v1", "devices"] => "/v1/devices",
        ["", "v1", "devices", _] => "/v1/devices/:deviceId",
        ["", "v1", "devices", _, "grants"] => "/v1/devices/:deviceId/grants",
        ["", "v1", "devices", _, "history"] => "/v1/devices/:deviceId/history",
        ["", "v1", "devices", _, "requests", _] => "/v1/devices/:deviceId/requests/:requestId",
        ["", "v1", "devices", _, "requests", _, "events"] => {
            "/v1/devices/:deviceId/requests/:requestId/events"
        }
        ["", "v1", "callers"] => "/v1/callers",
        ["", "v1", "history"] => "/v1/history",
        ["", "v1", "grants", _] => "/v1/grants/:grantId",
        ["", "v1", "requests"] => "/v1/requests",
        ["", "v1", "requests", _] => "/v1/requests/:requestId",
        ["", "v1", "requests", _, "cancel"] => "/v1/requests/:requestId/cancel",
        ["", "v2", "requests"] => "/v2/requests",
        ["", "v2", "requests", _] => "/v2/requests/:requestId",
        ["", "v2", "requests", _, "result"] => "/v2/requests/:requestId/result",
        ["", "v2", "requests", _, "cancel"] => "/v2/requests/:requestId/cancel",
        ["", "v2", "devices", _, "inbox"] => "/v2/devices/:deviceId/inbox",
        ["", "v2", "devices", _, "requests", _] => "/v2/devices/:deviceId/requests/:requestId",
        ["", "v2", "devices", _, "requests", _, "events"] => {
            "/v2/devices/:deviceId/requests/:requestId/events"
        }
        ["", "v2", "devices", _, "requests", _, "submissions"] => {
            "/v2/devices/:deviceId/requests/:requestId/submissions"
        }
        ["", "v2", "grants", _, "forms"] => "/v2/grants/:grantId/forms",
        ["", "v2", "webhooks"] => "/v2/webhooks",
        ["", "v2", "webhooks", _] => "/v2/webhooks/:hookId",
        ["", "v2", "events"] => "/v2/events",
        ["", "v2", "events", "stream"] => "/v2/events/stream",
        ["", "internal", "delivery"] => "/internal/delivery",
        ["", "internal", "maintenance"] => "/internal/maintenance",
        _ => "unmatched",
    }
}

fn safe_category(value: &str) -> &'static str {
    match value {
        "quota" => "quota",
        "timeout" => "timeout",
        "destination" => "destination",
        "rejected" => "rejected",
        "unavailable" => "unavailable",
        _ => "internal",
    }
}

fn nonnegative(value: &Value) -> f64 {
    value
        .as_f64()
        .filter(|v| v.is_finite())
        .unwrap_or(0.0)
        .max(0.0)
}

/// Reconstruct fixed-schema records rather than serializing arbitrary context.
pub fn entry(event: Value) -> Option<Value> {
    let name = text(&event, "event");
    let mut record = match name {
        "http_completed" => {
            let method = match text(&event, "method") {
                m @ ("GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS") => m,
                _ => "OTHER",
            };
            let route = route_template(text(&event, "route"));
            let status = match text(&event, "status_class") {
                s @ ("1xx" | "2xx" | "3xx" | "4xx" | "5xx") => s,
                _ => "5xx",
            };
            json!({"event":name,"method":method,"route":route,"status_class":status,"duration_ms":nonnegative(&event["duration_ms"])})
        }
        "delivery_lease_claimed" => {
            let kind = text(&event, "kind");
            if !["form", "webhook"].contains(&kind) {
                return None;
            }
            json!({"event":name,"kind":kind})
        }
        "delivery_attempt" => {
            let kind = match text(&event, "kind") {
                k @ ("sms" | "form" | "webhook") => k,
                _ => return None,
            };
            let outcome = match text(&event, "outcome") {
                o @ ("accepted" | "failed") => o,
                _ => return None,
            };
            let mut record = json!({"event":name,"kind":kind,"outcome":outcome,"age_ms":nonnegative(&event["age_ms"])});
            if outcome == "failed" {
                record["category"] = json!(safe_category(text(&event, "category")));
            }
            record
        }
        "fcm_send" => {
            let phase = text(&event, "phase");
            let kind = text(&event, "kind");
            let id = text(&event, "attempt_id");
            if !["started", "http_started", "completed"].contains(&phase)
                || !["sms", "form"].contains(&kind)
                || uuid::Uuid::parse_str(id).is_err()
            {
                return None;
            }
            let mut record = json!({"event":name,"phase":phase,"kind":kind,"attempt_id":id,
                "duration_ms":nonnegative(&event["duration_ms"]),"http_attempts":nonnegative(&event["http_attempts"]).min(1.0)});
            if phase == "completed" {
                let outcome = text(&event, "outcome");
                if !["accepted", "failed"].contains(&outcome) {
                    return None;
                }
                record["outcome"] = json!(outcome);
                if outcome == "failed" {
                    record["category"] = json!(safe_category(text(&event, "category")));
                }
            }
            record
        }
        "onboarding_outcome" => {
            let phase = text(&event, "phase");
            let outcome = text(&event, "outcome");
            if !["registration", "approval", "delivery", "setup"].contains(&phase)
                || ![
                    "pending",
                    "approved",
                    "denied",
                    "expired",
                    "available",
                    "acknowledged",
                    "phone_setup_needed",
                    "waiting_for_service",
                    "setup_complete",
                    "disconnected",
                    "failed",
                    "decided",
                ]
                .contains(&outcome)
            {
                return None;
            }
            json!({"event":name,"phase":phase,"outcome":outcome,"count":nonnegative(&event["count"]).min(100.0)})
        }
        "maintenance_completed" => {
            json!({"event":name,"duration_ms":nonnegative(&event["duration_ms"])})
        }
        "wakeup_failed"
        | "deletion_failed"
        | "maintenance_failed"
        | "backlog_sampling_failed"
        | "request_failed"
        | "mcp_tool_failed" => {
            json!({"event":name,"category":safe_category(text(&event, "category"))})
        }
        "backlog_snapshot" => {
            let kind = match text(&event, "kind") {
                k @ ("sms" | "form" | "webhook" | "results" | "form_results" | "deletion"
                | "legacy_deletion") => k,
                _ => return None,
            };
            json!({"event":name,"kind":kind,"count":nonnegative(&event["count"]),"oldest_due_age_s":nonnegative(&event["oldest_due_age_s"])})
        }
        _ => return None,
    };
    if (name == "delivery_lease_claimed"
        || (name == "http_completed"
            && ["/internal/delivery", "/internal/maintenance"].contains(&text(&record, "route"))))
        && crate::worker_context::WorkerContext::valid_trace(text(
            &event,
            "logging.googleapis.com/trace",
        ))
    {
        record["logging.googleapis.com/trace"] = event["logging.googleapis.com/trace"].clone();
    }
    record["component"] = json!("relay");
    record["severity"] = json!(if name.ends_with("_failed") {
        "ERROR"
    } else if ["delivery_attempt", "fcm_send"].contains(&name) && event["outcome"] == "failed" {
        "WARNING"
    } else {
        "INFO"
    });
    Some(record)
}

pub fn category(error: &Error) -> &'static str {
    match error {
        Error::Provider(value) => safe_category(value),
        Error::Api(_, "private_webhook_destination" | "invalid_webhook_url") => "destination",
        Error::Api(_, "webhook_timeout" | "webhook_dns_timeout") => "timeout",
        Error::Api(_, "webhook_rejected") => "rejected",
        Error::Api(429, _) => "quota",
        Error::Api(503, _) => "unavailable",
        Error::Store(firestore::errors::FirestoreError::DatabaseError(error)) => {
            match error.public.code.as_str() {
                "ResourceExhausted" => "quota",
                "DeadlineExceeded" | "CONNECTION_TIMEOUT" => "timeout",
                "Unavailable" | "CONNECTION_CLOSED" | "CONNECTION_ERROR" => "unavailable",
                _ => "internal",
            }
        }
        Error::Store(firestore::errors::FirestoreError::NetworkError(_)) => "unavailable",
        _ => "internal",
    }
}

pub(crate) fn due_sms_queries(now: i64) -> [Query; 3] {
    ["pending_phone", "ready", "awaiting_consent"].map(|status| {
        Query::new("requests")
            .eq("status", status)
            .eq("notificationSent", false)
            .cmp("nextNotificationAt", "<=", now)
            .order("nextNotificationAt", false)
    })
}

impl Relay {
    pub async fn telemetry_delivery(&self, kind: &str, created_at: i64, result: &Result<()>) {
        let mut event = json!({
            "event":"delivery_attempt","kind":kind,
            "outcome":if result.is_ok() {"accepted"} else {"failed"},
            "age_ms":(self.now()-created_at).max(0),
        });
        if let Err(error) = result {
            event["category"] = json!(category(error));
        }
        self.delivery.record(event).await;
    }

    pub async fn telemetry_backlogs(&self) -> Result<()> {
        let now = self.now();
        let mut queries = vec![
            (
                "form",
                "nextAt",
                Query::new("deliveryOutbox")
                    .cmp("nextAt", "<=", now)
                    .order("nextAt", false),
            ),
            (
                "results",
                "purgeAt",
                Query::new("results")
                    .cmp("purgeAt", "<=", now)
                    .order("purgeAt", false),
            ),
            (
                "form_results",
                "purgeAt",
                Query::new("formResults")
                    .cmp("purgeAt", "<=", now)
                    .order("purgeAt", false),
            ),
            (
                "legacy_deletion",
                "nextAt",
                Query::new("deletionAttempts")
                    .cmp("nextAt", "<=", now)
                    .order("nextAt", false),
            ),
            (
                "deletion",
                "backlogAt",
                Query::new("deletionJobs")
                    .cmp("backlogAt", "<=", now)
                    .order("backlogAt", false),
            ),
        ];
        queries.extend(due_sms_queries(now).map(|query| ("sms", "nextNotificationAt", query)));
        let samples = futures::future::try_join_all(queries.into_iter().map(
            |(kind, field, query)| async move {
                let (count, first) = tokio::try_join!(
                    self.store.count(query.clone()),
                    self.store.query(query.limit(1))
                )?;
                let age = first
                    .first()
                    .map(|doc| (now - num(doc, field)).max(0) / 1000)
                    .unwrap_or(0);
                Ok::<_, Error>((kind, count, age))
            },
        ))
        .await?;
        let mut combined: BTreeMap<&str, (i64, i64)> = BTreeMap::new();
        for (kind, count, age) in samples {
            let sample = combined.entry(kind).or_default();
            sample.0 += count;
            sample.1 = sample.1.max(age);
        }
        for (kind, (count, age)) in combined {
            self.delivery.record(json!({"event":"backlog_snapshot","kind":kind,"count":count,"oldest_due_age_s":age})).await;
        }
        Ok(())
    }

    pub async fn telemetry_maintenance(&self, auth: Arc<dyn Authentication>) -> Result<()> {
        self.telemetry_maintenance_with_context(auth, None).await
    }
    pub async fn telemetry_maintenance_with_context(
        &self,
        auth: Arc<dyn Authentication>,
        context: Option<&crate::worker_context::WorkerContext>,
    ) -> Result<()> {
        let started = self.now();
        let result: Result<()> = async {
            self.deletion_dispatch(auth).await?;
            self.maintenance_with_context(context).await
        }
        .await;
        if let Err(error) = result {
            self.delivery
                .emit("maintenance_failed", category(&error))
                .await;
            return Err(error);
        }
        if let Err(error) = self.telemetry_backlogs().await {
            self.delivery
                .emit("backlog_sampling_failed", category(&error))
                .await;
        }
        self.delivery
            .record(
                json!({"event":"maintenance_completed","duration_ms":(self.now()-started).max(0)}),
            )
            .await;
        Ok(())
    }
}

pub fn onboarding_outcome(path: &str, method: &str, status: u16, value: &Value) -> Option<Value> {
    let route = route_template(path);
    let phase = if route.starts_with("/v3/registration-sessions") {
        "registration"
    } else if route.starts_with("/v3/pairing-sessions")
        || route.starts_with("/v3/service/pairing-sessions")
        || route.starts_with("/v3/oauth/sessions")
        || route == "/v3/services/:id/connections"
    {
        "approval"
    } else if route.starts_with("/v3/service/deliveries") {
        "delivery"
    } else if method == "GET"
        && [
            "/v3/connection",
            "/v3/connections/:id",
            "/v3/service/connections/:id",
        ]
        .contains(&route)
    {
        "setup"
    } else {
        return None;
    };
    let outcome = if status >= 400 {
        if ["session_expired", "delivery_expired"].contains(&text(value, "error")) {
            "expired"
        } else {
            "failed"
        }
    } else if phase == "delivery" {
        if route.ends_with("/acknowledgement") {
            "acknowledged"
        } else {
            "available"
        }
    } else if phase == "setup" {
        text(value, "setup")
    } else if !text(value, "status").is_empty() {
        text(value, "status")
    } else if value.get("redirect").is_some() {
        "decided"
    } else {
        "pending"
    };
    let outcome = if [
        "pending",
        "approved",
        "denied",
        "expired",
        "available",
        "acknowledged",
        "phone_setup_needed",
        "waiting_for_service",
        "setup_complete",
        "disconnected",
        "failed",
        "decided",
    ]
    .contains(&outcome)
    {
        outcome
    } else {
        "failed"
    };
    let count = if phase == "delivery" && outcome == "available" {
        value["deliveries"]
            .as_array()
            .map_or(0, |a| a.len())
            .min(100)
    } else {
        1
    };
    Some(json!({"event":"onboarding_outcome","phase":phase,"outcome":outcome,"count":count}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_claim_and_finish_allow_only_standard_trace_metadata() {
        let trace = "projects/demo-sms-relay/traces/1234567890abcdef1234567890abcdef";
        for event in [
            json!({"event":"delivery_lease_claimed","kind":"webhook"}),
            json!({"event":"http_completed","method":"POST","route":"/internal/delivery","status_class":"5xx","duration_ms":5}),
        ] {
            let mut input = event;
            input["logging.googleapis.com/trace"] = json!(trace);
            input["ownerId"] = json!("private-owner");
            input["lease"] = json!("private-lease");
            input["query"] = json!("private-query");
            let out = entry(input).unwrap();
            assert_eq!(out["logging.googleapis.com/trace"], trace);
            assert!(!out.to_string().contains("private"));
        }
        let invalid = entry(json!({"event":"delivery_lease_claimed","kind":"form","logging.googleapis.com/trace":"projects/private/path/traces/token"})).unwrap();
        assert!(invalid.get("logging.googleapis.com/trace").is_none());
        let public = entry(json!({"event":"http_completed","method":"POST","route":"/v1/requests","status_class":"2xx","logging.googleapis.com/trace":trace})).unwrap();
        assert!(public.get("logging.googleapis.com/trace").is_none());
    }

    #[test]
    fn fcm_lifecycle_keeps_only_attempt_metadata() {
        let id = uuid::Uuid::new_v4().to_string();
        let value = entry(
            json!({"event":"fcm_send","phase":"completed","attempt_id":id,"kind":"form",
            "duration_ms":12,"http_attempts":1,"outcome":"failed","category":"timeout",
            "token":"private-token","ownerId":"private-owner","body":"private-response"}),
        )
        .unwrap();
        assert_eq!(value["severity"], "WARNING");
        assert_eq!(value["attempt_id"], id);
        assert!(!value.to_string().contains("private"));
        assert!(entry(json!({"event":"fcm_send","phase":"completed","attempt_id":"private-owner","kind":"form"})).is_none());
    }

    #[test]
    fn records_drop_private_context_and_derive_fixed_fields() {
        let event = entry(json!({"event":"delivery_attempt","kind":"sms","outcome":"failed","age_ms":-10,"category":"quota","code":"private-answer","token":"private-token","ownerId":"private-owner","severity":"INFO"})).unwrap();
        assert_eq!(
            event,
            json!({"event":"delivery_attempt","kind":"sms","outcome":"failed","age_ms":0.0,"category":"quota","component":"relay","severity":"WARNING"})
        );
        assert!(!event.to_string().contains("private"));
        assert!(entry(json!({"event":"private-token","category":"quota"})).is_none());
    }

    #[test]
    fn http_records_contain_route_templates_and_never_query_credentials() {
        let event = entry(json!({"event":"http_completed","method":"OTHER-PRIVATE","route":"/v1/devices/private-device/requests/private-id","status_class":"2xx","duration_ms":5})).unwrap();
        assert_eq!(event["route"], "/v1/devices/:deviceId/requests/:requestId");
        assert_eq!(event["method"], "OTHER");
        assert!(!event.to_string().contains("private"));
        assert_eq!(route_template("/unknown?token=private-token"), "unmatched");
        assert_eq!(route_template("/startup"), "/startup");
    }

    #[test]
    fn provider_categories_are_allowlisted_without_exposing_error_text() {
        assert_eq!(category(&Error::Provider("quota")), "quota");
        assert_eq!(category(&Error::Provider("timeout")), "timeout");
        assert_eq!(
            category(&Error::Provider("private-error-value")),
            "internal"
        );
        assert_eq!(
            category(&Error::Api(400, "private_webhook_destination")),
            "destination"
        );
    }
    #[test]
    fn firestore_transport_codes_keep_safe_failure_categories() {
        use firestore::errors::{
            FirestoreDatabaseError, FirestoreError, FirestoreErrorPublicGenericDetails,
        };
        for (code, expected) in [
            ("CONNECTION_TIMEOUT", "timeout"),
            ("CONNECTION_CLOSED", "unavailable"),
            ("CONNECTION_ERROR", "unavailable"),
            ("PermissionDenied", "internal"),
        ] {
            let error = Error::Store(FirestoreError::DatabaseError(FirestoreDatabaseError {
                public: FirestoreErrorPublicGenericDetails { code: code.into() },
                details: "private provider detail".into(),
                retry_possible: true,
            }));
            assert_eq!(category(&error), expected);
            let record =
                entry(json!({"event":"request_failed","category":category(&error)})).unwrap();
            assert!(!record.to_string().contains("private"));
        }
    }
}
