export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricLabels {
  [key: string]: string | number;
}

/**
 * Serializes labels dictionary to Prometheus format: {key1="val1",key2="val2"}.
 */
export function formatLabels(labels?: MetricLabels): string {
  if (!labels || Object.keys(labels).length === 0) {
    return '';
  }

  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => {
      const sanitizedKey = key.replace(/[^a-zA-Z0-9_]/g, '_');
      const escapedVal = String(val)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n');
      return `${sanitizedKey}="${escapedVal}"`;
    });

  return `{${parts.join(',')}}`;
}

export interface Metric {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  format(): string;
  reset(): void;
}

/**
 * Monotonically increasing Prometheus Counter.
 */
export class Counter implements Metric {
  readonly type: MetricType = 'counter';
  private values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels?: MetricLabels, value = 1): void {
    if (value < 0) {
      throw new Error(`Counter ${this.name} can only be incremented by non-negative values`);
    }
    const labelStr = formatLabels(labels);
    const current = this.values.get(labelStr) ?? 0;
    this.values.set(labelStr, current + value);
  }

  get(labels?: MetricLabels): number {
    return this.values.get(formatLabels(labels)) ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  format(): string {
    if (this.values.size === 0) {
      return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n`;
    }

    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [labels, val] of this.values.entries()) {
      lines.push(`${this.name}${labels} ${val}`);
    }
    return lines.join('\n') + '\n';
  }
}

/**
 * Arbitrary scalar value Prometheus Gauge (can increase, decrease, or be set).
 */
export class Gauge implements Metric {
  readonly type: MetricType = 'gauge';
  private values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  set(value: number, labels?: MetricLabels): void {
    const labelStr = formatLabels(labels);
    this.values.set(labelStr, value);
  }

  inc(labels?: MetricLabels, value = 1): void {
    const labelStr = formatLabels(labels);
    const current = this.values.get(labelStr) ?? 0;
    this.values.set(labelStr, current + value);
  }

  dec(labels?: MetricLabels, value = 1): void {
    const labelStr = formatLabels(labels);
    const current = this.values.get(labelStr) ?? 0;
    this.values.set(labelStr, current - value);
  }

  get(labels?: MetricLabels): number {
    return this.values.get(formatLabels(labels)) ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  format(): string {
    if (this.values.size === 0) {
      return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n`;
    }

    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [labels, val] of this.values.entries()) {
      lines.push(`${this.name}${labels} ${val}`);
    }
    return lines.join('\n') + '\n';
  }
}

export const DEFAULT_HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface HistogramSample {
  bucketCounts: number[];
  sum: number;
  count: number;
}

/**
 * Prometheus Histogram tracking distribution of observed values into configurable buckets.
 */
export class Histogram implements Metric {
  readonly type: MetricType = 'histogram';
  readonly buckets: number[];
  private samples = new Map<string, HistogramSample>();

  constructor(
    readonly name: string,
    readonly help: string,
    buckets: number[] = DEFAULT_HISTOGRAM_BUCKETS,
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels?: MetricLabels): void {
    const labelKey = formatLabels(labels);
    let sample = this.samples.get(labelKey);

    if (!sample) {
      sample = {
        bucketCounts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.samples.set(labelKey, sample);
    }

    sample.count++;
    sample.sum += value;

    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        sample.bucketCounts[i]++;
      }
    }
  }

  getSample(labels?: MetricLabels): HistogramSample | undefined {
    return this.samples.get(formatLabels(labels));
  }

  reset(): void {
    this.samples.clear();
  }

  format(): string {
    if (this.samples.size === 0) {
      return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} histogram\n`;
    }

    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];

    for (const [labelStr, sample] of this.samples.entries()) {
      // Parse base label string (e.g. `{method="GET"}` or empty)
      const baseLabels = labelStr ? labelStr.slice(1, -1) : '';

      for (let i = 0; i < this.buckets.length; i++) {
        const bucketLe = this.buckets[i];
        const lePart = `le="${bucketLe}"`;
        const bucketLabelStr = baseLabels ? `{${baseLabels},${lePart}}` : `{${lePart}}`;
        lines.push(`${this.name}_bucket${bucketLabelStr} ${sample.bucketCounts[i]}`);
      }

      const infPart = `le="+Inf"`;
      const infLabelStr = baseLabels ? `{${baseLabels},${infPart}}` : `{${infPart}}`;
      lines.push(`${this.name}_bucket${infLabelStr} ${sample.count}`);

      const statLabelStr = labelStr || '';
      lines.push(`${this.name}_sum${statLabelStr} ${sample.sum}`);
      lines.push(`${this.name}_count${statLabelStr} ${sample.count}`);
    }

    return lines.join('\n') + '\n';
  }
}
