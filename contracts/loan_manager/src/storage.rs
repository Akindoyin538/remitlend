use soroban_sdk::{contracttype, Address, Env};

/// Compact, versioned snapshot of the effective risk parameters that were in
/// force when a loan was originated. Once written it is never mutated, so
/// repayment, default and disclosure logic can rely on it instead of reading
/// mutable global configuration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RiskParamsSnapshot {
    /// Snapshot layout version. Bump when the representation changes.
    pub version: u32,
    /// Annualized interest rate in basis points.
    pub rate_bps: u32,
    /// Loan term in seconds.
    pub term_secs: u64,
    /// Origination fee in basis points.
    pub fee_bps: u32,
    /// Required collateral ratio in basis points.
    pub collateral_ratio_bps: u32,
    /// Governance policy version that produced these parameters.
    pub policy_version: u32,
}

/// Current snapshot layout version.
pub const RISK_SNAPSHOT_VERSION: u32 = 1;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Loan {
    pub borrower: Address,
    pub principal: i128,
    pub snapshot: RiskParamsSnapshot,
}

const LOAN_KEY: &str = "loan";

/// Persist a loan together with the immutable snapshot of the effective risk
/// parameters captured at origination.
pub fn save_loan(env: &Env, loan_id: u64, loan: &Loan) {
    env.storage().persistent().set(&(LOAN_KEY, loan_id), loan);
}

/// Load a loan. Legacy loans written before snapshots existed are upgraded on
/// read using the supplied fallback parameters so historical loans remain
/// readable under the current storage layout.
pub fn load_loan(
    env: &Env,
    loan_id: u64,
    legacy_fallback: &RiskParamsSnapshot,
) -> Option<Loan> {
    let key = (LOAN_KEY, loan_id);
    match env.storage().persistent().get::<_, Loan>(&key) {
        Some(loan) => Some(loan),
        None => None,
    }
    .or_else(|| {
        // Legacy layout: only borrower and principal were stored.
        #[contracttype]
        #[derive(Clone)]
        struct LegacyLoan {
            borrower: Address,
            principal: i128,
        }
        env.storage()
            .persistent()
            .get::<_, LegacyLoan>(&key)
            .map(|legacy| Loan {
                borrower: legacy.borrower,
                principal: legacy.principal,
                snapshot: legacy_fallback.clone(),
            })
    })
}
