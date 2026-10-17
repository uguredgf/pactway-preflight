// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Append-only audit commitments. Does not govern exchange execution.
/// @dev Hashes are supplied SHA-256 commitments to the public canonical source JSON.
contract MandateRegistry {
    address public immutable owner;
    address public immutable recorder;

    struct Task {
        bytes32 policyHash;
        bytes32 lastReceiptHash;
        uint256 sequence;
        bool committed;
    }

    mapping(bytes32 => Task) public tasks;
    mapping(bytes32 => bool) public recordedReceipts;

    event PolicyCommitted(bytes32 indexed taskId, bytes32 indexed policyHash);
    event DecisionRecorded(
        bytes32 indexed taskId,
        uint256 indexed sequence,
        bytes32 indexed receiptHash,
        bytes32 previousHash,
        bytes32 eventDigest
    );

    error Unauthorized();
    error InvalidCommitment();
    error PolicyAlreadyCommitted();
    error PolicyMissing();
    error InvalidSequence();
    error InvalidPreviousHash();
    error DuplicateReceipt();

    constructor(address recorder_) {
        if (recorder_ == address(0)) revert InvalidCommitment();
        owner = msg.sender;
        recorder = recorder_;
    }

    /// @notice A task's policy cannot be replaced. New policy needs a new task ID.
    function commitPolicy(bytes32 taskId, bytes32 policyHash) external {
        if (msg.sender != owner) revert Unauthorized();
        if (taskId == bytes32(0) || policyHash == bytes32(0)) revert InvalidCommitment();
        Task storage task = tasks[taskId];
        if (task.committed) revert PolicyAlreadyCommitted();
        task.policyHash = policyHash;
        task.committed = true;
        emit PolicyCommitted(taskId, policyHash);
    }

    /// @notice Records a supplied commitment, not proof of a CEX order or fill.
    function appendDecision(
        bytes32 taskId,
        uint256 sequence,
        bytes32 previousHash,
        bytes32 eventDigest,
        bytes32 receiptHash
    ) external {
        if (msg.sender != owner && msg.sender != recorder) revert Unauthorized();
        Task storage task = tasks[taskId];
        if (!task.committed) revert PolicyMissing();
        if (eventDigest == bytes32(0) || receiptHash == bytes32(0)) revert InvalidCommitment();
        if (sequence != task.sequence + 1) revert InvalidSequence();
        if (previousHash != task.lastReceiptHash) revert InvalidPreviousHash();
        if (recordedReceipts[receiptHash]) revert DuplicateReceipt();
        recordedReceipts[receiptHash] = true;
        task.sequence = sequence;
        task.lastReceiptHash = receiptHash;
        emit DecisionRecorded(taskId, sequence, receiptHash, previousHash, eventDigest);
    }
}
