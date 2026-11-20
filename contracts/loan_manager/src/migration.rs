//! Storage migration helper (#793).
//!
//! A contract implements [`MigrationHelper`] to describe its schema version and the
//! `migrate_v{N}_to_v{N+1}` steps. Migration is lazy: reads call `migrate_to_current`
//! (or a per-key migration) when stored data is still on an older schema, so old
//! entries never cause deserialization panics.
use soroban_sdk::Env;

pub trait MigrationHelper {
    /// Schema version this build of the contract expects.
    const SCHEMA_VERSION: u32;

    /// Schema version currently recorded in storage.
    fn storage_version(env: &Env) -> u32;

    /// Persist the schema version after a step completes.
    fn set_storage_version(env: &Env, version: u32);

    /// Run `migrate_v{from}_to_v{from+1}`. Must be idempotent.
    fn migrate_step(env: &Env, from: u32);

    /// Apply every pending step in order. Returns true if anything ran.
    fn migrate_to_current(env: &Env) -> bool {
        let mut version = Self::storage_version(env);
        let mut ran = false;
        while version < Self::SCHEMA_VERSION {
            Self::migrate_step(env, version);
            version += 1;
            Self::set_storage_version(env, version);
            ran = true;
        }
        ran
    }
}
