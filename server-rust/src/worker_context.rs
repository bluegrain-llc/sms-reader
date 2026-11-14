//! Optional authenticated-worker correlation. Never an authorization decision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerContext {
    trace: String,
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && value.bytes().any(|b| b != b'0')
}
fn project_id(value: &str) -> bool {
    (6..=30).contains(&value.len())
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
impl WorkerContext {
    pub fn from_headers(
        project: Option<&str>,
        parent: Option<&str>,
        legacy: Option<&str>,
    ) -> Option<Self> {
        let project = project.filter(|p| project_id(p))?;
        let parent = parent.map(|value| {
            if value.len() != 55 {
                return None;
            }
            let p = value.split('-').collect::<Vec<_>>();
            if p.len() != 4
                || p[0] != "00"
                || !hex(p[1], 32)
                || !hex(p[2], 16)
                || p[3].len() != 2
                || !p[3]
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return None;
            }
            Some((p[1], u64::from_str_radix(p[2], 16).ok()?))
        });
        let legacy = legacy.map(|value| {
            if value.len() > 57 {
                return None;
            }
            let (id, tail) = value.split_once('/')?;
            let span = match tail.split_once(";o=") {
                Some((span, "0" | "1")) => span,
                Some(_) => return None,
                None => tail,
            };
            if !hex(id, 32)
                || span.is_empty()
                || span.len() > 20
                || !span.bytes().all(|b| b.is_ascii_digit())
            {
                return None;
            }
            let span = span.parse::<u64>().ok()?;
            (span != 0).then_some((id, span))
        });
        // A supplied malformed or conflicting header yields no correlation.
        let parent = match parent {
            Some(value) => Some(value?),
            None => None,
        };
        let legacy = match legacy {
            Some(value) => Some(value?),
            None => None,
        };
        if parent.is_some() && legacy.is_some() && parent != legacy {
            return None;
        }
        let (id, _) = parent.or(legacy)?;
        Some(Self {
            trace: format!("projects/{project}/traces/{id}"),
        })
    }
    pub fn trace(&self) -> &str {
        &self.trace
    }
    pub(crate) fn valid_trace(value: &str) -> bool {
        let p = value.split('/').collect::<Vec<_>>();
        p.len() == 4 && p[0] == "projects" && project_id(p[1]) && p[2] == "traces" && hex(p[3], 32)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "1234567890abcdef1234567890abcdef";
    #[test]
    fn bounded_headers_require_trusted_project_and_agree() {
        let parent = format!("00-{ID}-0000000000000001-00");
        let legacy = format!("{ID}/1;o=0");
        let context =
            WorkerContext::from_headers(Some("demo-sms-relay"), Some(&parent), Some(&legacy))
                .unwrap();
        assert_eq!(
            context.trace(),
            format!("projects/demo-sms-relay/traces/{ID}")
        );
        for project in [
            None,
            Some("projects/evil"),
            Some("demo-project/private"),
            Some("ABCDEF"),
        ] {
            assert!(WorkerContext::from_headers(project, Some(&parent), None).is_none());
        }
        for invalid in [
            "private-token".to_owned(),
            format!("{ID}/0"),
            format!("{ID}/18446744073709551616"),
            format!("{ID}/1;o=0;private=secret"),
            format!("{}/1", "0".repeat(32)),
        ] {
            assert!(
                WorkerContext::from_headers(Some("demo-sms-relay"), None, Some(&invalid)).is_none()
            );
        }
        assert!(
            WorkerContext::from_headers(
                Some("demo-sms-relay"),
                Some(&parent),
                Some(&format!("{ID}/2"))
            )
            .is_none()
        );
        assert!(
            WorkerContext::from_headers(Some("demo-sms-relay"), Some("bad"), Some(&legacy))
                .is_none()
        );
        assert!(
            WorkerContext::from_headers(
                Some("demo-sms-relay"),
                Some(&parent),
                Some(&format!("{}/1", "f".repeat(32)))
            )
            .is_none()
        );
    }
}
