/**
 * Fail fast on missing configuration.
 *
 * The previous project defaulted `JWT_SECRET` to the literal 'change-me', so a
 * misconfigured deployment booted happily and signed tokens anybody could forge.
 * A service with missing secrets must refuse to start instead.
 */
export interface RequiredEnv {
  /** Variables that must be present and non-empty in every environment. */
  always: string[];
  /** Variables additionally required when NODE_ENV=production. */
  productionOnly?: string[];
}

const PLACEHOLDER_VALUES = new Set(['change-me', 'changeme', 'secret', 'password']);

export function validateEnv(serviceName: string, required: RequiredEnv): void {
  const isProduction = process.env.NODE_ENV === 'production';
  const names = [...required.always, ...(isProduction ? (required.productionOnly ?? []) : [])];

  const missing: string[] = [];
  const insecure: string[] = [];

  for (const name of names) {
    const value = process.env[name]?.trim();

    if (!value) {
      missing.push(name);
    } else if (isProduction && PLACEHOLDER_VALUES.has(value.toLowerCase())) {
      insecure.push(name);
    }
  }

  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(`missing: ${missing.join(', ')}`);
  }
  if (insecure.length > 0) {
    problems.push(`placeholder value used in production: ${insecure.join(', ')}`);
  }

  if (problems.length > 0) {
    throw new Error(`[${serviceName}] invalid configuration — ${problems.join('; ')}`);
  }
}
