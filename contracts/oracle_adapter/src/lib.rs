#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleAdapterError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    NoValidOraclePrice = 4,
    PriceToleranceExceeded = 5,
    StaleReading = 6,
    InvalidFreshnessWindow = 7,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OraclePriceReading {
    pub price: i128,
    pub timestamp: u64,
    pub source: Symbol,
}

#[contract]
pub struct OracleAdapter;

#[contractimpl]
impl OracleAdapter {
    pub fn initialize(env: Env, admin: Address, zenith_oracle: Address, reflector_oracle: Address, tolerance_bps: u32) {
        if env.storage().instance().has(&symbol_short!("ADMIN")) {
            panic!("already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&symbol_short!("ADMIN"), &admin);
        env.storage().instance().set(&symbol_short!("ZENITH"), &zenith_oracle);
        env.storage().instance().set(&symbol_short!("REFLECTOR"), &reflector_oracle);
        env.storage().instance().set(&symbol_short!("TOLERANCE"), &tolerance_bps);
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
        let tolerance_bps: u32 = env.storage().instance().get(&symbol_short!("TOLERANCE")).unwrap_or(200);

        // Fetch primary (Zenith) price
        let primary_price = Self::query_source(&env, &symbol_short!("ZENITH"), &asset);
        // Fetch fallback (Reflector) price
        let fallback_price = Self::query_source(&env, &symbol_short!("REFLECTOR"), &asset);

        match (primary_price, fallback_price) {
            (Some(p1), Some(p2)) => {
                let p1_fresh = Self::is_fresh(now, p1.timestamp, max_staleness);
                let p2_fresh = Self::is_fresh(now, p2.timestamp, max_staleness);
                if p1_fresh && p2_fresh {
                    let diff = if p1.price > p2.price { p1.price - p2.price } else { p2.price - p1.price };
                    let max_diff = (p1.price * tolerance_bps as i128) / 10_000;
                    if diff > max_diff {
                        return Err(OracleAdapterError::PriceToleranceExceeded);
                    }
                    Ok(p1)
                } else if p1_fresh {
                    Ok(p1)
                } else if p2_fresh {
                    Ok(p2)
                } else {
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
        Some(OraclePriceReading {
            price: 10_000_000, // 1.00 USDC
            timestamp: env.ledger().timestamp(),
            source: *key,
        })
    }
}
