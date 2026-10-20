//! Storage helpers with TTL liveness monitoring hooks.
//!
//! This module provides read-only helpers to inspect the remaining TTL of
//! tracked storage keys and derive a liveness status from it. All hooks are
//! additive and never mutate persisted state, so they remain compatible with
//! deployed contracts and existing storage layouts.

use soroban_sdk::{contracterror, contracttype, Env, IntoVal, Symbol, Val};

/// Maximum number of keys a single monitoring invocation may scan.
///
/// Bounds resource usage so a monitoring call can never iterate an unbounded
/// set of keys. Callers requesting more than this are rejected with
/// [`StorageMonitorError::TooManyKeys`].
pub const MAX_MONITORED_KEYS: u32 = 64;

/// Structured errors returned by the TTL liveness monitoring hooks.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum StorageMonitorError {
    /// The caller is not authorized to run monitoring hooks.
    Unauthorized = 1,
    /// The requested key count exceeds [`MAX_MONITORED_KEYS`].
    TooManyKeys = 2,
    /// A requested key has no live entry (never written or already expired).
    KeyNotFound = 3,
}

/// Liveness classification for a tracked storage key.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum LivenessStatus {
    /// TTL is comfortably above the warning threshold.
    Healthy = 0,
    /// TTL is at or below the warning threshold but still live.
    Warning = 1,
    /// TTL is at or below the critical threshold; extend soon.
    Critical = 2,
    /// The key has no live entry.
    Expired = 3,
}

/// Read-only snapshot of a single key's TTL liveness.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KeyLiveness {
    /// Remaining TTL in ledgers, or `0` when the key is not live.
    pub remaining_ttl: u32,
    /// Derived liveness status.
    pub status: LivenessStatus,
}

/// Thresholds (in ledgers) used to classify liveness.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LivenessThresholds {
    /// At or below this remaining TTL the key is `Critical`.
    pub critical: u32,
    /// At or below this remaining TTL the key is `Warning`.
    pub warning: u32,
}

impl LivenessThresholds {
    /// Validate that thresholds are ordered (`critical <= warning`).
    pub fn validate(&self) -> Result<(), StorageMonitorError> {
        if self.critical > self.warning {
            return Err(StorageMonitorError::Unauthorized);
        }
        Ok(())
    }
}

/// Classify a remaining TTL against the provided thresholds.
///
/// Pure function: no storage access, no mutation. `remaining_ttl == 0` is
/// treated as expired.
pub fn classify_liveness(remaining_ttl: u32, thresholds: LivenessThresholds) -> LivenessStatus {
    if remaining_ttl == 0 {
        LivenessStatus::Expired
    } else if remaining_ttl <= thresholds.critical {
        LivenessStatus::Critical
    } else if remaining_ttl <= thresholds.warning {
        LivenessStatus::Warning
    } else {
        LivenessStatus::Healthy
    }
}

/// Read the remaining TTL for a single key without mutating state.
///
/// Returns `Ok(0)` when the key has no live entry so callers can classify it
/// as expired rather than failing the whole monitoring pass.
pub fn read_key_liveness<K>(
    env: &Env,
    key: &K,
    thresholds: LivenessThresholds,
) -> Result<KeyLiveness, StorageMonitorError>
where
    K: IntoVal<Env, Val> + Clone,
{
    thresholds.validate()?;
    let remaining_ttl = env.storage().persistent().get_ttl(key);
    Ok(KeyLiveness {
        remaining_ttl,
        status: classify_liveness(remaining_ttl, thresholds),
    })
}

/// Read TTL liveness for a bounded batch of keys.
///
/// Rejects batches larger than [`MAX_MONITORED_KEYS`] with
/// [`StorageMonitorError::TooManyKeys`]. Read-only: never extends or mutates
/// TTLs, so it is safe to call from monitoring/operator entrypoints.
pub fn read_batch_liveness<K>(
    env: &Env,
    keys: &[K],
    thresholds: LivenessThresholds,
) -> Result<soroban_sdk::Vec<KeyLiveness>, StorageMonitorError>
where
    K: IntoVal<Env, Val> + Clone,
{
    thresholds.validate()?;
    if keys.len() as u32 > MAX_MONITORED_KEYS {
        return Err(StorageMonitorError::TooManyKeys);
    }
    let mut out = soroban_sdk::Vec::new(env);
    for key in keys {
        out.push_back(read_key_liveness(env, key, thresholds)?);
    }
    Ok(out)
}

/// Emit a structured diagnostic event describing a liveness snapshot.
///
/// Uses a dedicated topic so off-chain monitors can subscribe without
/// affecting existing event consumers.
pub fn emit_liveness_event(env: &Env, key: &Symbol, liveness: KeyLiveness) {
    env.events().publish(
        (Symbol::new(env, "ttl_liveness"), key.clone()),
        (liveness.remaining_ttl, liveness.status as u32),
    );
}
