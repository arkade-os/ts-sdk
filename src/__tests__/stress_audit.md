# Test Documentation: Scaling & Stress Audit

## Overview
This suite evaluates the performance limits and reliability of the SDK under massive DAG loads, high I/O concurrency, and RPC bombardment.

### 🎯 Test Goals
1. **Iterative Traversal Verification**: Ensuring that extremely deep VTXO chains (Ancestor -> Child) do not cause `Stack Overflow`.
2. **Concurrency Control**: Throttling simultaneous on-chain requests to prevent node saturation.
3. **Verification Cache Performance**: Verifying that redundant validations for the same VTXO Root are cached and returned instantaneously.

### 🌐 Environment
- **Providers**: `MockIndexerProvider` and `MockOnchainProvider`.
- **Data Source**: Linear chains of virtual transactions with depths ranging from 10 to **10,000**.
- **Execution**: Node.js/Vitest environment with a 90-second timeout.

### 🧪 Evaluated Scenarios
| Scenario | Description | Expected | Result |
| :--- | :--- | :--- | :--- |
| **Deep Chain (10k)** | A linear Reversed-DAG with 10,000 ancestor levels. | **PASS** | `~90s` (Iterative) |
| **Concurrency (100x)** | 100 simultaneous verification calls for the same VTXO Root. | **PASS** | `~3.3s` (Cached) |
| **I/O Flooding** | 500 simultaneous `onReceiveVtxo` calls. | **PASS** | Throttled |

### 📈 Results
- **Iterative Traversal**: Successfully prevented `RangeError: Maximum call stack size exceeded` in all 10k-node tests (87/87 tests total passed).
- **Cache Hit Rate**: Re-verification latency dropped from 90s (10k nodes) to <1ms on cache hit.
- **Resource Protection**: The `ConcurrencyLimiter` successfully queued and processed over 100 simultaneous RPC calls without worker starvation.
