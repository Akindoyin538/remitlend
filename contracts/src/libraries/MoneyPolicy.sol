// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MoneyPolicy
/// @notice Canonical integer money policy for pool share conversion.
/// @dev All conversions use integer arithmetic only (no floating point).
///      Rounding is conservative: shares are rounded DOWN on deposit and
///      assets are rounded DOWN on withdrawal, so existing holders can never
///      lose value because another user splits a transaction into smaller
///      operations. Residual (unredeemable) units stay in the pool and are
///      only recoverable through the pool's approved dust-sweep path.
library MoneyPolicy {
    /// @notice Thrown when a conversion is attempted with a zero denominator.
    error DivisionByZero();

    /// @notice Thrown when a deposit would mint zero shares for non-zero assets.
    error ZeroSharesMinted();

    /// @notice Thrown when a withdrawal would redeem zero assets for non-zero shares.
    error ZeroAssetsRedeemed();

    /// @notice Convert assets to shares, rounding DOWN (favours the pool).
    /// @param assets Amount of underlying assets being deposited.
    /// @param totalAssets Total assets currently held by the pool (pre-deposit).
    /// @param totalShares Total shares currently outstanding (pre-deposit).
    /// @return shares Shares to mint. Zero when the pool is empty (bootstrap).
    function assetsToShares(uint256 assets, uint256 totalAssets, uint256 totalShares)
        internal
        pure
        returns (uint256 shares)
    {
        if (assets == 0) {
            return 0;
        }
        // Empty-pool initialization: deterministic 1:1 bootstrap.
        if (totalShares == 0 || totalAssets == 0) {
            return assets;
        }
        // shares = floor(assets * totalShares / totalAssets)
        shares = (assets * totalShares) / totalAssets;
    }

    /// @notice Convert shares to assets, rounding DOWN (favours the pool).
    /// @param shares Amount of shares being redeemed.
    /// @param totalAssets Total assets currently held by the pool (pre-withdraw).
    /// @param totalShares Total shares currently outstanding (pre-withdraw).
    /// @return assets Assets to pay out.
    function sharesToAssets(uint256 shares, uint256 totalAssets, uint256 totalShares)
        internal
        pure
        returns (uint256 assets)
    {
        if (shares == 0) {
            return 0;
        }
        if (totalShares == 0) {
            revert DivisionByZero();
        }
        // assets = floor(shares * totalAssets / totalShares)
        assets = (shares * totalAssets) / totalShares;
    }

    /// @notice Deposit helper enforcing conservative rounding invariants.
    /// @dev Reverts if a non-zero deposit would mint zero shares, preventing
    ///      silent value donation to the pool from dust-sized deposits.
    function previewDeposit(uint256 assets, uint256 totalAssets, uint256 totalShares)
        internal
        pure
        returns (uint256 shares)
    {
        shares = assetsToShares(assets, totalAssets, totalShares);
        if (assets != 0 && shares == 0) {
            revert ZeroSharesMinted();
        }
    }

    /// @notice Withdraw helper enforcing conservative rounding invariants.
    /// @dev Reverts if a non-zero redemption would pay zero assets, preventing
    ///      silent share burn with no compensation.
    function previewWithdraw(uint256 shares, uint256 totalAssets, uint256 totalShares)
        internal
        pure
        returns (uint256 assets)
    {
        assets = sharesToAssets(shares, totalAssets, totalShares);
        if (shares != 0 && assets == 0) {
            revert ZeroAssetsRedeemed();
        }
    }

    /// @notice Regression vector shared with the backend preview calculation.
    /// @dev Encodes the canonical rounding behaviour so off-chain previews and
    ///      on-chain conversions agree exactly. Returns the expected shares for
    ///      a deposit of `assets` into a pool with `totalAssets`/`totalShares`.
    ///      Vector: deposit 3 assets into (10 assets, 7 shares) => 2 shares
    ///      (floor(3 * 7 / 10) = 2), and redeem 2 shares from (13 assets, 9
    ///      shares) => 2 assets (floor(2 * 13 / 9) = 2).
    function regressionVector() internal pure returns (uint256 depositShares, uint256 withdrawAssets) {
        depositShares = assetsToShares(3, 10, 7);
        withdrawAssets = sharesToAssets(2, 13, 9);
    }
}
