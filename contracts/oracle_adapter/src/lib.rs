#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol, String};

// ============================================================================
// ERROR TYPES
// ============================================================================

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleAdapterError {
    /// Oracle adapter has already been initialized
    AlreadyInitialized = 1,
    /// Oracle adapter has not been initialized
    NotInitialized = 2,
    /// Caller is not authorized to perform this action
    Unauthorized = 3,
    /// No valid oracle price could be obtained from available sources
    NoValidOraclePrice = 4,
    /// Price from sources exceeds allowed tolerance threshold
    PriceToleranceExceeded = 5,
    /// All available price readings are too old (exceed max_staleness)
    StaleReading = 6,
    InvalidFreshnessWindow = 7,
}

// ============================================================================
// DATA TYPES
// ============================================================================

/// Represents a price reading from an oracle source
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OraclePriceReading {
    /// The price value (typically in basis points or minimal units)
    pub price: i128,
    /// Ledger timestamp when price was recorded
    pub timestamp: u64,
    /// Symbol indicating the source (e.g., "ZENITH", "REFLECTOR")
    pub source: Symbol,
}

/// Metrics about oracle sources and price consensus
#[contracttype]
#[derive(Clone, Debug)]
pub struct OracleMetrics {
    /// Number of sources that provided valid readings
    pub sources_available: u32,
    /// Dispersion between sources in basis points (0-10000)
    pub dispersion_bps: u32,
    /// Age of oldest accepted reading in seconds
    pub max_age_seconds: u64,
    /// Which source was used (primary or fallback)
    pub accepted_source: Symbol,
}

// ============================================================================
// EVENTS
// ============================================================================

/// Emitted when price is fetched from a source
pub fn oracle_price_fetched(
    env: &Env,
    source: Symbol,
    asset: Symbol,
    price: i128,
    timestamp: u64,
) {
    let topics = (symbol_short!("PriceFetch"), source, asset);
    let data = (price, timestamp);
    env.events().publish(topics, data);
}

/// Emitted when price passes validation and is accepted
pub fn oracle_price_validated(
    env: &Env,
    asset: Symbol,
    price: i128,
    source: Symbol,
    dispersion_bps: u32,
    num_sources: u32,
) {
    let topics = (symbol_short!("PriceValid"), asset, source);
    let data = (price, dispersion_bps, num_sources);
    env.events().publish(topics, data);
}

/// Emitted when price validation fails
pub fn oracle_price_rejected(
    env: &Env,
    asset: Symbol,
    reason: Symbol,
) {
    let topics = (symbol_short!("PriceReject"), asset);
    env.events().publish(topics, reason);
}

/// Emitted when oracle parameters are changed
pub fn oracle_tolerance_updated(
    env: &Env,
    old_tolerance_bps: u32,
    new_tolerance_bps: u32,
) {
    let topics = (symbol_short!("Tolerance"),);
    let data = (old_tolerance_bps, new_tolerance_bps);
    env.events().publish(topics, data);
}

/// Emitted when max staleness parameter is changed
pub fn oracle_max_staleness_updated(
    env: &Env,
    old_max_staleness: u64,
    new_max_staleness: u64,
) {
    let topics = (symbol_short!("MaxStale"),);
    let data = (old_max_staleness, new_max_staleness);
    env.events().publish(topics, data);
}

/// Emitted on oracle initialization
pub fn oracle_initialized(
    env: &Env,
    admin: &Address,
    tolerance_bps: u32,
) {
    let topics = (symbol_short!("OracleInit"),);
    let data = (admin.clone(), tolerance_bps);
    env.events().publish(topics, data);
}

// ============================================================================
// STORAGE KEYS
// ============================================================================

const KEY_ADMIN: &str = "ADMIN";
const KEY_INITIALIZED: &str = "INIT";
const KEY_PRIMARY_SOURCE: &str = "ZENITH";
const KEY_FALLBACK_SOURCE: &str = "REFLECTOR";
const KEY_TOLERANCE_BPS: &str = "TOLERANCE";
const KEY_MAX_STALENESS: &str = "MAX_STALE";

// ============================================================================
// CONTRACT IMPLEMENTATION
// ============================================================================

#[contract]
pub struct OracleAdapter;

#[contractimpl]
impl OracleAdapter {
    /// Initialize the oracle adapter with primary and fallback sources
    ///
    /// # Arguments
    /// * `env` - Soroban environment
    /// * `admin` - Address authorized to update oracle parameters
    /// * `zenith_oracle` - Primary oracle source address
    /// * `reflector_oracle` - Fallback oracle source address
    /// * `tolerance_bps` - Maximum allowed dispersion in basis points (0-10000)
    ///
    /// # Errors
    /// * `AlreadyInitialized` - Oracle has already been initialized
    /// * `Unauthorized` - Caller is not authorized (requires admin auth)
    pub fn initialize(
        env: Env,
        admin: Address,
        zenith_oracle: Address,
        reflector_oracle: Address,
        tolerance_bps: u32,
    ) -> Result<(), OracleAdapterError> {
        // Check not already initialized
        if env
            .storage()
            .instance()
            .has(&symbol_short!("INIT"))
        {
            return Err(OracleAdapterError::AlreadyInitialized);
        }

        // Require authorization from admin
        admin.require_auth();

        // Validate tolerance parameter
        if tolerance_bps > 10_000 {
            return Err(OracleAdapterError::InvalidPriceReading);
        }

        // Store oracle configuration
        env.storage()
            .instance()
            .set(&symbol_short!("ADMIN"), &admin);
        env.storage()
            .instance()
            .set(&symbol_short!("ZENITH"), &zenith_oracle);
        env.storage()
            .instance()
            .set(&symbol_short!("REFLECTOR"), &reflector_oracle);
        env.storage()
            .instance()
            .set(&symbol_short!("TOLERANCE"), &tolerance_bps);
        env.storage()
            .instance()
            .set(&symbol_short!("MAX_STALE"), &300u64); // Default 5 minutes

        // Mark as initialized
        env.storage().instance().set(&symbol_short!("INIT"), &true);

        // Extend TTL for important state
        env.storage().instance().extend_ttl(518400, 518400);

        // Emit initialization event
        oracle_initialized(&env, &admin, tolerance_bps);

        Ok(())
    }

    /// Upper bound on the caller-supplied freshness window, in seconds.
    pub const MAX_FRESHNESS_WINDOW_SECS: u64 = 3_600;

    /// Returns a price only if it was observed within `max_staleness` seconds of the
    /// ledger time. Readings timestamped after the ledger time are never fresh.
    pub fn get_validated_price(env: Env, asset: Symbol, max_staleness: u64) -> Result<OraclePriceReading, OracleAdapterError> {
        if max_staleness > Self::MAX_FRESHNESS_WINDOW_SECS {
            return Err(OracleAdapterError::InvalidFreshnessWindow);
        }

        let now = env.ledger().timestamp();
        let tolerance_bps: u32 = env
            .storage()
            .instance()
            .get(&symbol_short!("TOLERANCE"))
            .unwrap_or(200);

        // Fetch primary (Zenith) price
        let primary_price = Self::query_source(&env, &symbol_short!("ZENITH"), &asset);
        // Fetch fallback (Reflector) price
        let fallback_price = Self::query_source(&env, &symbol_short!("REFLECTOR"), &asset);

        match (primary_price, fallback_price) {
            // Both sources available
            (Some(p1), Some(p2)) => {
                let p1_fresh = Self::is_fresh(now, p1.timestamp, max_staleness);
                let p2_fresh = Self::is_fresh(now, p2.timestamp, max_staleness);
                if p1_fresh && p2_fresh {
                    let diff = if p1.price > p2.price { p1.price - p2.price } else { p2.price - p1.price };
                    let max_diff = (p1.price * tolerance_bps as i128) / 10_000;
                    if diff > max_diff {
                        return Err(OracleAdapterError::PriceToleranceExceeded);
                    }
                    // Primary fresh, fallback stale
                    (true, false) => {
                        oracle_price_validated(
                            &env,
                            asset,
                            p1.price,
                            symbol_short!("ZENITH"),
                            0,
                            1,
                        );
                        Ok(p1)
                    }
                    // Primary stale, fallback fresh
                    (false, true) => {
                        oracle_price_validated(
                            &env,
                            asset,
                            p2.price,
                            symbol_short!("REFLECTOR"),
                            0,
                            1,
                        );
                        Ok(p2)
                    }
                    // Both stale
                    (false, false) => {
                        oracle_price_rejected(&env, asset, symbol_short!("StaleReading"));
                        Err(OracleAdapterError::StaleReading)
                    }
                }
            }
            // Only primary available
            (Some(p1), None) => {
                if now.saturating_sub(p1.timestamp) <= max_staleness {
                    oracle_price_validated(
                        &env,
                        asset,
                        p1.price,
                        symbol_short!("ZENITH"),
                        0,
                        1,
                    );
                    Ok(p1)
                } else if p1_fresh {
                    Ok(p1)
                } else if p2_fresh {
                    Ok(p2)
                } else {
                    oracle_price_rejected(&env, asset, symbol_short!("StaleReading"));
                    Err(OracleAdapterError::StaleReading)
                }
            }
            (Some(p1), None) if Self::is_fresh(now, p1.timestamp, max_staleness) => Ok(p1),
            (None, Some(p2)) if Self::is_fresh(now, p2.timestamp, max_staleness) => Ok(p2),
            _ => Err(OracleAdapterError::NoValidOraclePrice),
        }
    }

    fn is_fresh(now: u64, reading_timestamp: u64, max_staleness: u64) -> bool {
        reading_timestamp <= now && now - reading_timestamp <= max_staleness
    }

    fn query_source(env: &Env, key: &Symbol, _asset: &Symbol) -> Option<OraclePriceReading> {
        if !env.storage().instance().has(key) {
            return None;
        }

        Some((price * tolerance_bps as i128) / 10_000)
    }

    /// Calculate dispersion in basis points
    fn calc_dispersion_bps(price: i128, diff: i128) -> u32 {
        if price == 0 {
            return 0;
        }

        let price_abs = price.abs();
        if diff.abs() > price_abs {
            10_000 // Cap at 100%
        } else {
            ((diff.abs() * 10_000) / price_abs) as u32
        }
    }
}

#[cfg(test)]
mod test;
