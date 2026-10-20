//! Contracts package: storage TTL liveness monitoring hooks.
//!
//! This module exposes read-only monitoring hooks that report the remaining
//! TTL and liveness status for tracked storage keys. The hooks never mutate
//! persisted state and are additive to the existing contract surface, so
//! deployed contracts, storage layouts, and API consumers remain compatible.

use std::collections::BTreeMap;

/// Maximum number of keys a single monitoring invocation may scan.
///
/// Bounds resource usage so a monitoring call cannot be used to exhaust
/// compute or read budgets. Inputs exceeding this cap are rejected with a
/// structured error rather than silently truncated.
pub const MAX_MONITORED_KEYS: usize = 128;

/// Structured error returned by monitoring hooks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonitorError {
    /// The caller is not authorized to invoke monitoring hooks.
    Unauthorized,
    /// The requested key set exceeds [`MAX_MONITORED_KEYS`].
    TooManyKeys { requested: usize, max: usize },
    /// A tracked key was not found in storage.
    KeyNotFound { key: String },
}

/// Liveness classification for a tracked storage key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    /// TTL is comfortably above the warning threshold.
    Healthy,
    /// TTL is at or below the warning threshold but still live.
    Warning,
    /// TTL has expired; the entry is no longer live.
    Expired,
}

/// Read-only snapshot of a single tracked key's TTL liveness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyLiveness {
    pub key: String,
    pub remaining_ttl: u64,
    pub liveness: Liveness,
}

/// Read-only view over storage used by monitoring hooks.
///
/// Implementors must not mutate state; the trait is intentionally read-only
/// so monitoring cannot alter persisted data layout or contract state.
pub trait TtlReader {
    /// Returns the remaining TTL (in ledgers) for `key`, or `None` if absent.
    fn remaining_ttl(&self, key: &str) -> Option<u64>;
}

/// Authorization gate for monitoring hooks.
///
/// Monitoring is operator-gated: only an authorized operator may read TTL
/// liveness. Unauthorized callers receive [`MonitorError::Unauthorized`].
pub fn authorize_monitor(is_operator: bool) -> Result<(), MonitorError> {
    if is_operator {
        Ok(())
    } else {
        Err(MonitorError::Unauthorized)
    }
}

/// Classifies remaining TTL into a [`Liveness`] status.
fn classify(remaining_ttl: u64, warn_threshold: u64) -> Liveness {
    if remaining_ttl == 0 {
        Liveness::Expired
    } else if remaining_ttl <= warn_threshold {
        Liveness::Warning
    } else {
        Liveness::Healthy
    }
}

/// Reports TTL liveness for each tracked key without mutating state.
///
/// - Rejects unauthorized callers with [`MonitorError::Unauthorized`].
/// - Rejects key sets larger than [`MAX_MONITORED_KEYS`] with
///   [`MonitorError::TooManyKeys`].
/// - Returns [`MonitorError::KeyNotFound`] for any tracked key missing from
///   storage, so stale tracking data surfaces as an explicit failure.
pub fn monitor_ttl<R: TtlReader>(
    reader: &R,
    is_operator: bool,
    keys: &[String],
    warn_threshold: u64,
) -> Result<Vec<KeyLiveness>, MonitorError> {
    authorize_monitor(is_operator)?;

    if keys.len() > MAX_MONITORED_KEYS {
        return Err(MonitorError::TooManyKeys {
            requested: keys.len(),
            max: MAX_MONITORED_KEYS,
        });
    }

    let mut report = Vec::with_capacity(keys.len());
    for key in keys {
        let remaining_ttl = reader
            .remaining_ttl(key)
            .ok_or_else(|| MonitorError::KeyNotFound { key: key.clone() })?;
        report.push(KeyLiveness {
            key: key.clone(),
            remaining_ttl,
            liveness: classify(remaining_ttl, warn_threshold),
        });
    }
    Ok(report)
}

/// Aggregates a liveness report into per-status counts for metrics emission.
pub fn summarize(report: &[KeyLiveness]) -> BTreeMap<&'static str, usize> {
    let mut counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    for entry in report {
        let label = match entry.liveness {
            Liveness::Healthy => "healthy",
            Liveness::Warning => "warning",
            Liveness::Expired => "expired",
        };
        *counts.entry(label).or_insert(0) += 1;
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MapReader(BTreeMap<String, u64>);

    impl TtlReader for MapReader {
        fn remaining_ttl(&self, key: &str) -> Option<u64> {
            self.0.get(key).copied()
        }
    }

    fn reader(pairs: &[(&str, u64)]) -> MapReader {
        MapReader(
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_string(), *v))
                .collect(),
        )
    }

    fn keys(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_string()).collect()
    }

    #[test]
    fn reports_liveness_statuses() {
        let r = reader(&[("a", 100), ("b", 5), ("c", 0)]);
        let report = monitor_ttl(&r, true, &keys(&["a", "b", "c"]), 10).unwrap();
        assert_eq!(report[0].liveness, Liveness::Healthy);
        assert_eq!(report[1].liveness, Liveness::Warning);
        assert_eq!(report[2].liveness, Liveness::Expired);
    }

    #[test]
    fn rejects_unauthorized() {
        let r = reader(&[("a", 100)]);
        assert_eq!(
            monitor_ttl(&r, false, &keys(&["a"]), 10),
            Err(MonitorError::Unauthorized)
        );
    }

    #[test]
    fn rejects_oversized_input() {
        let r = reader(&[]);
        let many: Vec<String> = (0..=MAX_MONITORED_KEYS).map(|i| i.to_string()).collect();
        assert_eq!(
            monitor_ttl(&r, true, &many, 10),
            Err(MonitorError::TooManyKeys {
                requested: MAX_MONITORED_KEYS + 1,
                max: MAX_MONITORED_KEYS,
            })
        );
    }

    #[test]
    fn reports_missing_key() {
        let r = reader(&[]);
        assert_eq!(
            monitor_ttl(&r, true, &keys(&["missing"]), 10),
            Err(MonitorError::KeyNotFound {
                key: "missing".to_string()
            })
        );
    }

    #[test]
    fn boundary_threshold_is_warning() {
        let r = reader(&[("edge", 10)]);
        let report = monitor_ttl(&r, true, &keys(&["edge"]), 10).unwrap();
        assert_eq!(report[0].liveness, Liveness::Warning);
    }

    #[test]
    fn summarize_counts_statuses() {
        let r = reader(&[("a", 100), ("b", 5), ("c", 0)]);
        let report = monitor_ttl(&r, true, &keys(&["a", "b", "c"]), 10).unwrap();
        let counts = summarize(&report);
        assert_eq!(counts.get("healthy"), Some(&1));
        assert_eq!(counts.get("warning"), Some(&1));
        assert_eq!(counts.get("expired"), Some(&1));
    }
}
