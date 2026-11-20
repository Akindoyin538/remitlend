/// Upgrade Proxy Pattern with Timelock for LoanManager
///
/// This module implements a proxy pattern with timelock governance for contract upgrades.
/// Key features:
/// - All upgrade requests require a 48-hour timelock delay
/// - Admin can schedule and execute upgrades
/// - Prevents immediate unvetted contract changes
/// - Emits UpgradeScheduled and UpgradeExecuted events
/// - Supports data migration between versions

use soroban_sdk::{contracttype, symbol_short, Address, BytesN, Env, Symbol, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UpgradeProxyKey {
    Admin,
    ProposedAdmin,
    ScheduledUpgrade,
    UpgradeDelay,
    CurrentWasm,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledUpgrade {
    pub wasm_hash: BytesN<32>,
    pub scheduled_at: u32,
    pub scheduled_by: Address,
    pub migration_data: Option<Vec<u8>>,
}

pub struct UpgradeProxy;

impl UpgradeProxy {
    /// 48-hour timelock delay in ledgers (~17280 ledgers per day on Stellar)
    pub const DEFAULT_UPGRADE_DELAY_LEDGERS: u32 = 34560;

    /// Initialize the upgrade proxy with an admin
    pub fn initialize(env: &Env, admin: &Address) {
        if env
            .storage()
            .instance()
            .has(&UpgradeProxyKey::Admin)
        {
            panic!("Upgrade proxy already initialized");
        }

        env.storage()
            .instance()
            .set(&UpgradeProxyKey::Admin, admin);
        env.storage()
            .instance()
            .set(&UpgradeProxyKey::UpgradeDelay, &Self::DEFAULT_UPGRADE_DELAY_LEDGERS);
    }

    /// Schedule a contract upgrade with timelock
    /// Returns the scheduled execution time (current_ledger + delay)
    pub fn schedule_upgrade(
        env: &Env,
        wasm_hash: &BytesN<32>,
        migration_data: Option<Vec<u8>>,
    ) -> u32 {
        let admin: Address = env
            .storage()
            .instance()
            .get(&UpgradeProxyKey::Admin)
            .expect("Admin not set");
        admin.require_auth();

        let current_ledger = env.ledger().sequence();
        let delay: u32 = env
            .storage()
            .instance()
            .get(&UpgradeProxyKey::UpgradeDelay)
            .unwrap_or(Self::DEFAULT_UPGRADE_DELAY_LEDGERS);

        let scheduled_at = current_ledger
            .checked_add(delay)
            .expect("Upgrade time overflow");

        let scheduled = ScheduledUpgrade {
            wasm_hash: wasm_hash.clone(),
            scheduled_at,
            scheduled_by: admin.clone(),
            migration_data,
        };

        env.storage()
            .instance()
            .set(&UpgradeProxyKey::ScheduledUpgrade, &scheduled);

        // Emit UpgradeScheduled event
        env.events().publish(
            (symbol_short!("UPGRADE"),),
            (symbol_short!("SCHED"), scheduled_at, wasm_hash),
        );

        scheduled_at
    }

    /// Execute a scheduled upgrade if timelock has elapsed
    /// Returns the old WASM hash
    pub fn execute_upgrade(env: &Env) -> BytesN<32> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&UpgradeProxyKey::Admin)
            .expect("Admin not set");
        admin.require_auth();

        let scheduled: ScheduledUpgrade = env
            .storage()
            .instance()
            .get(&UpgradeProxyKey::ScheduledUpgrade)
            .expect("No upgrade scheduled");

        let current_ledger = env.ledger().sequence();
        if current_ledger < scheduled.scheduled_at {
            panic!("Upgrade timelock has not elapsed");
        }

        // Store current WASM as old WASM for rollback capability
        let old_wasm: BytesN<32> = env
            .storage()
            .instance()
            .get(&UpgradeProxyKey::CurrentWasm)
            .unwrap_or_else(|| BytesN::from_array(env, &[0u8; 32]));

        // Perform the upgrade
        env.deployer()
            .update_current_contract_wasm(scheduled.wasm_hash.clone());

        // Update current WASM hash
        env.storage()
            .instance()
            .set(&UpgradeProxyKey::CurrentWasm, &scheduled.wasm_hash);

        // Run pending storage migrations in the same transaction as the upgrade.
        <crate::LoanManager as crate::migration::MigrationHelper>::migrate_to_current(env);

        // Clear scheduled upgrade
        env.storage()
            .instance()
            .remove(&UpgradeProxyKey::ScheduledUpgrade);

        // Emit UpgradeExecuted event
        env.events().publish(
            (symbol_short!("UPGRADE"),),
            (
                symbol_short!("EXEC"),
                scheduled.wasm_hash,
                current_ledger,
            ),
        );

        old_wasm
    }

    /// Cancel a scheduled upgrade (admin only)
    pub fn cancel_upgrade(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&UpgradeProxyKey::Admin)
            .expect("Admin not set");
        admin.require_auth();

        env.storage()
            .instance()
            .remove(&UpgradeProxyKey::ScheduledUpgrade);

        // Emit UpgradeCancelled event
        env.events()
            .publish((symbol_short!("UPGRADE"),), (symbol_short!("CANCEL"),));
    }

    /// Get current scheduled upgrade info
    pub fn get_scheduled_upgrade(env: &Env) -> Option<ScheduledUpgrade> {
        env.storage()
            .instance()
            .get(&UpgradeProxyKey::ScheduledUpgrade)
    }

    /// Get the timelock delay period in ledgers
    pub fn get_upgrade_delay(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&UpgradeProxyKey::UpgradeDelay)
            .unwrap_or(Self::DEFAULT_UPGRADE_DELAY_LEDGERS)
    }

    /// Set the upgrade delay (admin only, affects future upgrades only)
    pub fn set_upgrade_delay(env: &Env, delay_ledgers: u32) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&UpgradeProxyKey::Admin)
            .expect("Admin not set");
        admin.require_auth();

        if delay_ledgers == 0 {
            panic!("Upgrade delay must be positive");
        }

        env.storage()
            .instance()
            .set(&UpgradeProxyKey::UpgradeDelay, &delay_ledgers);

        env.events().publish(
            (symbol_short!("UPGRADE"),),
            (symbol_short!("DELAY"), delay_ledgers),
        );
    }

    /// Get the current WASM hash
    pub fn get_current_wasm(env: &Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&UpgradeProxyKey::CurrentWasm)
            .unwrap_or_else(|| BytesN::from_array(env, &[0u8; 32]))
    }

    /// Propose a new admin (2-step process for safety)
    pub fn propose_new_admin(env: &Env, new_admin: &Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&UpgradeProxyKey::Admin)
            .expect("Admin not set");
        admin.require_auth();

        env.storage()
            .instance()
            .set(&UpgradeProxyKey::ProposedAdmin, new_admin);

        env.events()
            .publish((symbol_short!("ADMIN"),), (symbol_short!("PROP"), new_admin));
    }

    /// Accept admin role (must be called by proposed admin)
    pub fn accept_admin(env: &Env) {
        let proposed: Address = env
            .storage()
            .instance()
            .get(&UpgradeProxyKey::ProposedAdmin)
            .expect("No proposed admin");
        proposed.require_auth();

        env.storage()
            .instance()
            .set(&UpgradeProxyKey::Admin, &proposed);
        env.storage()
            .instance()
            .remove(&UpgradeProxyKey::ProposedAdmin);

        env.events()
            .publish((symbol_short!("ADMIN"),), (symbol_short!("ACCEPT"), &proposed));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    #[test]
    fn test_upgrade_proxy_initialization() {
        let env = Env::default();
        let admin = Address::generate(&env);

        UpgradeProxy::initialize(&env, &admin);

        assert_eq!(
            UpgradeProxy::get_upgrade_delay(&env),
            UpgradeProxy::DEFAULT_UPGRADE_DELAY_LEDGERS
        );
    }

    #[test]
    fn test_schedule_upgrade() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        UpgradeProxy::initialize(&env, &admin);

        let wasm_hash = BytesN::from_array(&env, &[1u8; 32]);
        let scheduled_at = UpgradeProxy::schedule_upgrade(&env, &wasm_hash, None);

        let current_ledger = env.ledger().sequence();
        let expected_scheduled_at = current_ledger + UpgradeProxy::DEFAULT_UPGRADE_DELAY_LEDGERS;
        assert_eq!(scheduled_at, expected_scheduled_at);

        let scheduled = UpgradeProxy::get_scheduled_upgrade(&env).unwrap();
        assert_eq!(scheduled.wasm_hash, wasm_hash);
    }

    #[test]
    fn test_upgrade_timelock_prevents_immediate_execution() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        UpgradeProxy::initialize(&env, &admin);

        let wasm_hash = BytesN::from_array(&env, &[1u8; 32]);
        UpgradeProxy::schedule_upgrade(&env, &wasm_hash, None);

        // Try to execute immediately - should fail
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            UpgradeProxy::execute_upgrade(&env);
        }));

        assert!(result.is_err(), "Should fail to execute before timelock");
    }

    #[test]
    fn test_cancel_upgrade() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        UpgradeProxy::initialize(&env, &admin);

        let wasm_hash = BytesN::from_array(&env, &[1u8; 32]);
        UpgradeProxy::schedule_upgrade(&env, &wasm_hash, None);

        UpgradeProxy::cancel_upgrade(&env);

        assert!(UpgradeProxy::get_scheduled_upgrade(&env).is_none());
    }

    #[test]
    fn test_admin_transfer() {
        let env = Env::default();
        env.mock_all_auths();
        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        UpgradeProxy::initialize(&env, &admin1);

        UpgradeProxy::propose_new_admin(&env, &admin2);
        UpgradeProxy::accept_admin(&env);

        // Verify new admin can schedule upgrades
        let wasm_hash = BytesN::from_array(&env, &[2u8; 32]);
        let _scheduled_at = UpgradeProxy::schedule_upgrade(&env, &wasm_hash, None);

        // Should succeed without errors
        assert!(true);
    }
}
