/**
 * Unit tests for src/shared/retry.js — the exponential-backoff retry behind the
 * vector writes, collection discovery at startup and Auto-Reformat's batches.
 */

import { describe, it, expect, vi } from 'vitest';
import { retry } from '../src/shared/retry.js';

describe('retry', () => {
    it('should return result on first success', async () => {
        const operation = vi.fn().mockResolvedValue('success');
        const result = await retry(operation);
        expect(result).toBe('success');
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure', async () => {
        const operation = vi.fn()
            .mockRejectedValueOnce(new Error('fail'))
            .mockRejectedValueOnce(new Error('fail'))
            .mockResolvedValue('success');

        const result = await retry(operation, {
            maxAttempts: 3,
            delay: 10
        });

        expect(result).toBe('success');
        expect(operation).toHaveBeenCalledTimes(3);
    });

    it('should throw after max attempts', async () => {
        const operation = vi.fn().mockRejectedValue(new Error('always fails'));

        await expect(retry(operation, {
            maxAttempts: 2,
            delay: 10
        })).rejects.toThrow('always fails');

        expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should call onRetry callback', async () => {
        const onRetry = vi.fn();
        const operation = vi.fn()
            .mockRejectedValueOnce(new Error('fail'))
            .mockResolvedValue('success');

        await retry(operation, {
            maxAttempts: 3,
            delay: 10,
            onRetry
        });

        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
    });

    it('should respect shouldRetry callback', async () => {
        const operation = vi.fn().mockRejectedValue(new Error('no retry'));
        const shouldRetry = vi.fn().mockReturnValue(false);

        await expect(retry(operation, {
            maxAttempts: 3,
            delay: 10,
            shouldRetry
        })).rejects.toThrow('no retry');

        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should apply exponential backoff', async () => {
        const operation = vi.fn()
            .mockRejectedValueOnce(new Error('fail'))
            .mockResolvedValue('success');

        const start = Date.now();
        await retry(operation, {
            maxAttempts: 2,
            delay: 50,
            backoffFactor: 2
        });
        const elapsed = Date.now() - start;

        // First retry should wait 50ms
        expect(elapsed).toBeGreaterThanOrEqual(40);
    });
});
