import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getGlobalMetricsRegistry } from '@libs/common';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive failures required to trip the circuit to OPEN. Defaults to 5. */
  failureThreshold?: number;
  /** Cooldown duration in milliseconds before moving from OPEN to HALF_OPEN. Defaults to 15,000ms. */
  recoveryTimeoutMs?: number;
  /** Consecutive successful probe requests required to close the circuit from HALF_OPEN. Defaults to 2. */
  halfOpenMaxTrials?: number;
}

export interface CircuitBreakerSnapshot {
  serviceKey: string;
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  openedAt: number | null;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  lastError: string | null;
  recoveryTimeoutMs: number;
  failureThreshold: number;
}

/**
 * In-memory Circuit Breaker state machine protecting the API Gateway against
 * cascading upstream failures and thread/connection exhaustion.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAt: number | null = null;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private lastError: string | null = null;

  readonly failureThreshold: number;
  readonly recoveryTimeoutMs: number;
  readonly halfOpenMaxTrials: number;

  constructor(
    readonly serviceKey: string,
    options?: CircuitBreakerOptions,
  ) {
    this.failureThreshold = options?.failureThreshold ?? 5;
    this.recoveryTimeoutMs = options?.recoveryTimeoutMs ?? 15000;
    this.halfOpenMaxTrials = options?.halfOpenMaxTrials ?? 2;
    getGlobalMetricsRegistry().circuitBreakerState.set(0, { service_key: this.serviceKey });
  }

  /**
   * Evaluates current state, automatically transitioning from OPEN to HALF_OPEN
   * once recoveryTimeoutMs has elapsed.
   */
  getState(): CircuitState {
    if (this.state === 'OPEN' && this.openedAt !== null) {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.recoveryTimeoutMs) {
        this.transitionTo('HALF_OPEN');
      }
    }
    return this.state;
  }

  isOpen(): boolean {
    return this.getState() === 'OPEN';
  }

  getRetryAfterSeconds(): number {
    if (this.state !== 'OPEN' || this.openedAt === null) {
      return 0;
    }
    const elapsed = Date.now() - this.openedAt;
    const remaining = this.recoveryTimeoutMs - elapsed;
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  recordSuccess(): void {
    const currentState = this.getState();
    this.lastSuccessTime = Date.now();
    this.lastError = null;

    if (currentState === 'HALF_OPEN') {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.halfOpenMaxTrials) {
        this.transitionTo('CLOSED');
      }
    } else if (currentState === 'CLOSED') {
      this.consecutiveFailures = 0;
    }
  }

  recordFailure(error?: unknown): void {
    this.lastFailureTime = Date.now();
    this.lastError = error instanceof Error ? error.message : String(error ?? 'Unknown error');

    const currentState = this.getState();

    if (currentState === 'HALF_OPEN') {
      // Any failure during trial probe immediately trips back to OPEN
      this.transitionTo('OPEN');
    } else if (currentState === 'CLOSED') {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.transitionTo('OPEN');
      }
    }
  }

  reset(): void {
    this.transitionTo('CLOSED');
  }

  private transitionTo(newState: CircuitState): void {
    this.state = newState;
    const stateValue = newState === 'CLOSED' ? 0 : newState === 'HALF_OPEN' ? 1 : 2;
    getGlobalMetricsRegistry().circuitBreakerState.set(stateValue, {
      service_key: this.serviceKey,
    });

    if (newState === 'OPEN') {
      this.openedAt = Date.now();
      this.consecutiveSuccesses = 0;
    } else if (newState === 'HALF_OPEN') {
      this.consecutiveSuccesses = 0;
    } else if (newState === 'CLOSED') {
      this.openedAt = null;
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses = 0;
    }
  }

  getSnapshot(): CircuitBreakerSnapshot {
    return {
      serviceKey: this.serviceKey,
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      openedAt: this.openedAt,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      lastError: this.lastError,
      recoveryTimeoutMs: this.recoveryTimeoutMs,
      failureThreshold: this.failureThreshold,
    };
  }
}

/**
 * Manages per-upstream Circuit Breakers to isolate failures across distinct
 * microservices in the mesh.
 */
@Injectable()
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly defaultOptions: CircuitBreakerOptions;

  constructor(private readonly configService?: ConfigService) {
    this.defaultOptions = {
      failureThreshold: this.configService?.get<number>('circuitBreakerFailureThreshold') ?? 5,
      recoveryTimeoutMs:
        this.configService?.get<number>('circuitBreakerRecoveryTimeoutMs') ?? 15000,
      halfOpenMaxTrials: this.configService?.get<number>('circuitBreakerHalfOpenTrials') ?? 2,
    };
  }

  getBreaker(serviceKey: string, customOptions?: CircuitBreakerOptions): CircuitBreaker {
    let breaker = this.breakers.get(serviceKey);
    if (!breaker) {
      breaker = new CircuitBreaker(serviceKey, { ...this.defaultOptions, ...customOptions });
      this.breakers.set(serviceKey, breaker);
    }
    return breaker;
  }

  getAllSnapshots(): CircuitBreakerSnapshot[] {
    return Array.from(this.breakers.values()).map((b) => b.getSnapshot());
  }

  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}
