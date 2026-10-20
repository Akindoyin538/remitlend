use soroban_sdk::{contracttype, Address, BytesN, Env};

/// Current snapshot schema version. Bump when the snapshot layout changes.
pub const RISK_SNAPSHOT_VERSION: u32 = 1;

/// Immutable, compact snapshot of the effective risk parameters captured at
/// loan origination. Later lifecycle operations (repayment, default,
/// disclosure) must read these values instead of mutable global config so
/// governance changes cannot retroactively alter borrower obligations.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RiskSnapshot {
    /// Snapshot schema version for forward/backward compatible decoding.
    pub version: u32,
    /// Interest rate in basis points (e.g. 500 = 5.00%).
    pub rate_bps: u32,
    /// Loan term in seconds.
    pub term_secs: u64,
    /// Origination fee in basis points.
    pub fee_bps: u32,
    /// Required collateral ratio in basis points.
    pub collateral_ratio_bps: u32,
    /// Policy/config version that produced these parameters.
    pub policy_version: u32,
}

impl RiskSnapshot {
    /// Build a snapshot from the current effective parameters at origination.
    pub fn capture(
        rate_bps: u32,
        term_secs: u64,
        fee_bps: u32,
        collateral_ratio_bps: u32,
        policy_version: u32,
    ) -> Self {
        Self {
            version: RISK_SNAPSHOT_VERSION,
            rate_bps,
            term_secs,
            fee_bps,
            collateral_ratio_bps,
            policy_version,
        }
    }

    /// Default snapshot for legacy loans persisted before snapshots existed.
    /// Keeps existing loans readable under the current storage layout.
    pub fn legacy() -> Self {
        Self {
            version: 0,
            rate_bps: 0,
            term_secs: 0,
            fee_bps: 0,
            collateral_ratio_bps: 0,
            policy_version: 0,
        }
    }

    /// True when this snapshot was captured at origination (not a legacy default).
    pub fn is_captured(&self) -> bool {
        self.version >= RISK_SNAPSHOT_VERSION
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Loan {
    pub borrower: Address,
    pub principal: i128,
    pub collateral: i128,
    pub created_at: u64,
    /// Effective risk parameters frozen at origination.
    pub risk: RiskSnapshot,
}

impl Loan {
    /// Originate a loan, capturing the effective risk parameters immutably.
    pub fn originate(
        _env: &Env,
        borrower: Address,
        principal: i128,
        collateral: i128,
        created_at: u64,
        risk: RiskSnapshot,
    ) -> Self {
        Self {
            borrower,
            principal,
            collateral,
            created_at,
            risk,
        }
    }

    /// Read the loan's frozen risk snapshot. Lifecycle logic must use this
    /// rather than reading mutable global parameters.
    pub fn risk_snapshot(&self) -> &RiskSnapshot {
        &self.risk
    }
}

/// Storage key helpers for persisting loans and their snapshots.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Loan(BytesN<32>),
    PolicyVersion,
}
