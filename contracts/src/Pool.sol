// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Pool
/// @notice Integer-only pool share accounting with conservative rounding.
/// @dev Money policy: all share/asset conversions use unsigned integer math only.
///      - Deposits mint shares rounded DOWN (floor).
///      - Withdrawals return assets rounded DOWN (floor).
///      This guarantees that splitting a deposit or withdrawal into smaller
///      operations can never yield more redeemable value than a single combined
///      operation, so existing holders cannot lose value to rounding.
contract Pool {
    error ZeroAmount();
    error InsufficientShares();
    error InsufficientLiquidity();
    error NotApproved();

    /// @notice Total pool shares outstanding.
    uint256 public totalShares;

    /// @notice Total underlying assets held by the pool.
    uint256 public totalAssets;

    /// @notice Shares held per account.
    mapping(address => uint256) public sharesOf;

    /// @notice Address permitted to sweep unredeemable dust.
    address public immutable dustRecipient;

    /// @notice Accumulated unredeemable dust (assets that cannot be redeemed).
    uint256 public dust;

    event Deposit(address indexed user, uint256 assets, uint256 shares);
    event Withdraw(address indexed user, uint256 shares, uint256 assets);
    event DustSwept(address indexed to, uint256 amount);

    constructor(address _dustRecipient) {
        require(_dustRecipient != address(0), "dust recipient");
        dustRecipient = _dustRecipient;
    }

    /// @notice Preview shares minted for a given asset deposit (floor rounding).
    /// @dev Shared regression vector with backend preview calculation.
    ///      Empty pool bootstraps 1:1 (shares == assets).
    function previewDeposit(uint256 assets) public view returns (uint256) {
        if (assets == 0) return 0;
        if (totalShares == 0 || totalAssets == 0) return assets;
        return (assets * totalShares) / totalAssets;
    }

    /// @notice Preview assets returned for a given share redemption (floor rounding).
    function previewWithdraw(uint256 shares) public view returns (uint256) {
        if (shares == 0) return 0;
        if (totalShares == 0) return 0;
        return (shares * totalAssets) / totalShares;
    }

    /// @notice Deposit assets and mint shares rounded down.
    function deposit(uint256 assets) external returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        shares = previewDeposit(assets);
        if (shares == 0) revert ZeroAmount();

        // Any asset remainder that cannot be represented as shares is dust.
        uint256 accounted = shares;
        if (totalShares != 0 && totalAssets != 0) {
            // assets - shares*totalAssets/totalShares is the rounding residual.
            uint256 represented = (shares * totalAssets) / totalShares;
            if (assets > represented) {
                dust += assets - represented;
                accounted = represented;
            }
        }

        totalAssets += accounted;
        totalShares += shares;
        sharesOf[msg.sender] += shares;

        emit Deposit(msg.sender, accounted, shares);
    }

    /// @notice Redeem shares for assets rounded down.
    function withdraw(uint256 shares) external returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (sharesOf[msg.sender] < shares) revert InsufficientShares();

        assets = previewWithdraw(shares);
        if (assets == 0) revert ZeroAmount();
        if (assets > totalAssets) revert InsufficientLiquidity();

        // Residual asset units that cannot be redeemed become dust.
        uint256 represented = (shares * totalAssets) / totalShares;
        if (assets > represented) {
            dust += assets - represented;
            assets = represented;
        }

        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        totalAssets -= assets;

        emit Withdraw(msg.sender, shares, assets);
    }

    /// @notice Sweep accumulated unredeemable dust to the approved recipient only.
    function sweepDust() external returns (uint256 amount) {
        if (msg.sender != dustRecipient) revert NotApproved();
        amount = dust;
        if (amount == 0) revert ZeroAmount();
        dust = 0;
        emit DustSwept(dustRecipient, amount);
    }
}
