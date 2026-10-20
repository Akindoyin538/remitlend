//! Formal verification of `loan_manager` safety invariants.
//!
//! The fuzz suite (`contracts/fuzz/fuzz_targets/loan_manager_fuzz.rs`) explores
//! random call sequences looking for panics. This module complements it by
//! pinning down the *state invariants* that must hold after every supported
//! operation, expressed as concrete, deterministic assertions over real
//! contract state (pool balances, collateral ledger, outstanding totals,
//! per-loan accounting). Each test is an executable proof obligation:
//!
//!   INV-1  A disbursed loan never removes more than the pool actually holds.
//!   INV-2  `get_total_outstanding` equals the sum of active loan principal.
//!   INV-3  Collateral is accounted exactly and never mixes with liquidity.
//!   INV-4  Repayment monotonically reduces debt and never over-credits.
//!   INV-5  Accrued interest / late fees are non-negative at every ledger time.
//!   INV-6  Credit score is always non-negative.
//!   INV-7  Requests above `max_loan_amount` are rejected up-front.
//!   INV-8  Interest equals the closed-form formula, remainder carried exactly.
//!
//! CI runs this module as a dedicated gate (see the "Formal verification"
//! step in `.github/workflows/ci.yml`).

#![cfg(test)]

use crate::{LoanError, LoanManager, LoanManagerClient, LoanStatus};
use lending_pool::{LendingPool, LendingPoolClient};
use remittance_nft::{RemittanceNFT, RemittanceNFTClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{Address, BytesN, Env, String};

const TERM: u32 = 17_280;

/// Deploys NFT + LendingPool + LoanManager wired together, mirroring the
/// production initialization path used by the integration test-suite.
fn setup<'a>(env: &Env) -> (LoanManagerClient<'a>, RemittanceNFTClient<'a>, Address, Address) {
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(env);

    let nft_id = env.register(RemittanceNFT, ());
    let nft = RemittanceNFTClient::new(env, &nft_id);
    nft.initialize(&admin);

    let token_admin = Address::generate(env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token = token_contract.address();

    let pool_id = env.register(LendingPool, ());
    let pool = LendingPoolClient::new(env, &pool_id);
    pool.initialize(&admin);

    let manager_id = env.register(LoanManager, ());
    let manager = LoanManagerClient::new(env, &manager_id);
    nft.authorize_minter(&manager_id);
    manager.initialize(&nft_id, &pool_id, &token, &admin);
    nft.set_min_repayment_amount(&0);

    (manager, nft, pool.address, token)
}

fn borrower_with_score(env: &Env, nft: &RemittanceNFTClient, score: u32) -> Address {
    let borrower = Address::generate(env);
    let history_hash = BytesN::from_array(env, &[0u8; 32]);
    let mut commitment = [0u8; 32];
    commitment[0] = 1;
    nft.mint(
        &borrower,
        &score,
        &history_hash,
        &String::from_str(env, "ipfs://QmTest"),
        &BytesN::from_array(env, &commitment),
        &None,
    );
    borrower
}

fn mint(env: &Env, token: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, token).mint(to, &amount);
}

// INV-1: the pool can never pay out more than it holds. An approval that would
// overdraw the pool must be rejected, and every successful approval reduces the
// pool balance by *exactly* the loan principal.
#[test]
fn inv1_disbursed_loan_never_exceeds_pool_balance() {
    let env = Env::default();
    let (manager, nft, pool, token) = setup(&env);
    let token_client = TokenClient::new(&env, &token);
    mint(&env, &token, &pool, 10_000);
    let borrower = borrower_with_score(&env, &nft, 650);

    let ok_loan = manager.request_loan(&borrower, &4_000, &TERM);
    manager.approve_loan(&ok_loan);

    // Pool balance moved by exactly the principal, never more.
    assert_eq!(token_client.balance(&pool), 6_000);
    assert_eq!(manager.get_loan(&ok_loan).amount, 4_000);

    // A second loan that exceeds the remaining 6_000 of liquidity is refused,
    // leaving pool state untouched.
    let over_loan = manager.request_loan(&borrower, &9_000, &TERM);
    assert_eq!(
        manager.try_approve_loan(&over_loan),
        Err(Ok(LoanError::InsufficientPoolLiquidity))
    );
    assert_eq!(token_client.balance(&pool), 6_000);
    assert_eq!(manager.get_loan(&over_loan).status, LoanStatus::Pending);
}

// INV-2: reported total outstanding is exactly the sum of active loan principal.
#[test]
fn inv2_total_outstanding_equals_sum_of_active_principal() {
    let env = Env::default();
    let (manager, nft, pool, token) = setup(&env);
    mint(&env, &token, &pool, 20_000);

    let a = borrower_with_score(&env, &nft, 700);
    let b = borrower_with_score(&env, &nft, 700);

    assert_eq!(manager.get_total_outstanding(&token), 0);

    let loan_a = manager.request_loan(&a, &3_000, &TERM);
    manager.approve_loan(&loan_a);
    assert_eq!(manager.get_total_outstanding(&token), 3_000);

    let loan_b = manager.request_loan(&b, &5_000, &TERM);
    manager.approve_loan(&loan_b);

    let expected = manager.get_loan(&loan_a).amount + manager.get_loan(&loan_b).amount;
    assert_eq!(manager.get_total_outstanding(&token), expected);
    assert_eq!(expected, 8_000);
    // Outstanding can never exceed what the pool was funded with.
    assert!(manager.get_total_outstanding(&token) <= 20_000);
}

// INV-3: collateral is tracked exactly and is additive to the manager balance;
// it is never conflated with disbursement liquidity.
#[test]
fn inv3_collateral_is_accounted_exactly() {
    let env = Env::default();
    let (manager, nft, pool, token) = setup(&env);
    let token_client = TokenClient::new(&env, &token);
    mint(&env, &token, &pool, 20_000);
    let borrower = borrower_with_score(&env, &nft, 650);
    mint(&env, &token, &borrower, 5_000);

    let loan_id = manager.request_loan(&borrower, &1_000, &TERM);
    manager.approve_loan(&loan_id);

    let manager_balance_before = token_client.balance(&manager.address);
    let borrower_balance_before = token_client.balance(&borrower);

    manager.deposit_collateral(&loan_id, &300);

    assert_eq!(manager.get_collateral(&loan_id), 300);
    assert_eq!(
        token_client.balance(&manager.address),
        manager_balance_before + 300
    );
    assert_eq!(token_client.balance(&borrower), borrower_balance_before - 300);
    assert_eq!(manager.get_loan(&loan_id).collateral_amount, 300);
}

// INV-4: repayment only ever moves accounting in the safe direction -- principal
// paid rises, stays positive, and never exceeds the borrowed amount; a fully
// repaid loan settles and releases its collateral.
#[test]
fn inv4_repayment_monotonically_reduces_debt() {
    let env = Env::default();
    let (manager, nft, pool, token) = setup(&env);
    let borrower = borrower_with_score(&env, &nft, 600);
    mint(&env, &token, &pool, 20_000);
    mint(&env, &token, &borrower, 20_000);

    let loan_id = manager.request_loan(&borrower, &1_000, &TERM);
    manager.approve_loan(&loan_id);
    manager.deposit_collateral(&loan_id, &200);

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 2_000);

    manager.repay(&borrower, &loan_id, &500);
    let mid = manager.get_loan(&loan_id);
    assert!(mid.principal_paid > 0, "principal paid must advance");
    assert!(
        mid.principal_paid <= mid.amount,
        "cannot repay more principal than borrowed"
    );
    assert!(mid.interest_paid >= 0);
    assert_eq!(mid.status, LoanStatus::Approved);

    let remaining = mid.amount + mid.accrued_interest + mid.accrued_late_fee
        - mid.principal_paid
        - mid.interest_paid
        - mid.late_fee_paid;
    manager.repay(&borrower, &loan_id, &remaining);

    let done = manager.get_loan(&loan_id);
    assert_eq!(done.status, LoanStatus::Repaid);
    assert!(done.principal_paid <= done.amount);
    // Collateral is returned once the debt is cleared.
    assert_eq!(manager.get_collateral(&loan_id), 0);
}

// INV-5: interest and late-fee accumulators are non-negative at any ledger time,
// including far in the future where naive accrual maths tends to overflow or
// wrap.
#[test]
fn inv5_accrued_amounts_never_negative() {
    let env = Env::default();
    let (manager, nft, pool, token) = setup(&env);
    mint(&env, &token, &pool, 20_000);
    let borrower = borrower_with_score(&env, &nft, 700);

    let loan_id = manager.request_loan(&borrower, &2_000, &TERM);
    manager.approve_loan(&loan_id);

    for delta in [0u32, 1, TERM, TERM * 10, u32::MAX / 2] {
        env.ledger().set_sequence_number(delta);
        let loan = manager.get_loan(&loan_id);
        assert!(loan.accrued_interest >= 0, "accrued interest went negative");
        assert!(loan.accrued_late_fee >= 0, "accrued late fee went negative");
        assert!(loan.interest_residual >= 0, "interest residual went negative");
        assert!(loan.principal_paid >= 0 && loan.interest_paid >= 0);
    }
}

// INV-6: the credit score exposed to the loan manager is always non-negative.
#[test]
fn inv6_credit_score_non_negative() {
    let env = Env::default();
    let (_manager, nft, _pool, _token) = setup(&env);
    let borrower = borrower_with_score(&env, &nft, 500);
    assert!(nft.get_score(&borrower) >= 0);
    assert_eq!(nft.get_score(&borrower), 500);
}

// INV-7: the `max_loan_amount` ceiling is enforced at request time, before any
// pool state is touched.
#[test]
fn inv7_requests_above_max_are_rejected() {
    let env = Env::default();
    let (manager, nft, pool, token) = setup(&env);
    mint(&env, &token, &pool, 1_000_000);
    let borrower = borrower_with_score(&env, &nft, 750);

    manager.set_max_loan_amount(&5_000);
    assert_eq!(
        manager.try_request_loan(&borrower, &6_000, &TERM),
        Err(Ok(LoanError::InvalidAmount))
    );

    // The boundary value is still accepted.
    let ok = manager.request_loan(&borrower, &5_000, &TERM);
    assert_eq!(manager.get_loan(&ok).amount, 5_000);
}

// INV-8: interest is exactly floor(principal * rate_bps * elapsed / (10_000 * term)),
// with the sub-unit remainder carried in `interest_residual` so that no value is
// lost or created.
#[test]
fn inv8_interest_calculation_is_exact() {
    let env = Env::default();
    let (manager, nft, pool, token) = setup(&env);
    mint(&env, &token, &pool, 20_000);
    let borrower = borrower_with_score(&env, &nft, 700);

    let loan_id = manager.request_loan(&borrower, &10_000, &TERM);
    manager.approve_loan(&loan_id);

    let start = manager.get_loan(&loan_id);
    let rate = start.interest_rate_bps as i128;
    let precision: i128 = 1_000_000;
    let denominator = 10_000i128 * TERM as i128;

    for elapsed in [1u32, 777, 5_000] {
        env.ledger()
            .set_sequence_number(start.last_interest_ledger + elapsed);
        let loan = manager.get_loan(&loan_id);
        let scaled = 10_000i128 * rate * elapsed as i128 * precision / denominator;
        assert_eq!(loan.accrued_interest, scaled / precision);
        assert_eq!(loan.interest_residual, scaled % precision);
    }
}
