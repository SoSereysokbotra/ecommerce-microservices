/**
 * Administrative Dead Letter Queue (DLQ) Manager
 *
 * Usage:
 *   npx ts-node scripts/rabbitmq-dlq.ts stats
 *   npx ts-node scripts/rabbitmq-dlq.ts replay <queue> [limit]
 *   npx ts-node scripts/rabbitmq-dlq.ts purge <queue>
 */
import * as amqp from 'amqplib';

const RABBITMQ_URL = process.env.RABBITMQ_URL ?? 'amqp://localhost:5672';
const MAIN_EXCHANGE = process.env.RABBITMQ_EXCHANGE ?? 'commerce.events';
const KNOWN_QUEUES = [
  'users-service',
  'catalog-service',
  'inventory-service',
  'orders-service',
  'payments-service',
  'cart-service',
  'pricing-service',
  'shipping-service',
  'search-service',
  'reviews-service',
  'recommendations-service',
];

async function main() {
  const [action, targetQueue, limitArg] = process.argv.slice(2);

  if (!action || !['stats', 'replay', 'purge'].includes(action)) {
    console.log(`
RabbitMQ Dead Letter Queue Manager
----------------------------------
Usage:
  npx ts-node scripts/rabbitmq-dlq.ts stats
  npx ts-node scripts/rabbitmq-dlq.ts replay <queue-name> [max-messages]
  npx ts-node scripts/rabbitmq-dlq.ts purge <queue-name>

Examples:
  npx ts-node scripts/rabbitmq-dlq.ts stats
  npx ts-node scripts/rabbitmq-dlq.ts replay shipping-service 50
  npx ts-node scripts/rabbitmq-dlq.ts purge shipping-service
`);
    process.exit(0);
  }

  console.log(`Connecting to RabbitMQ at ${RABBITMQ_URL}...`);
  const connection = await amqp.connect(RABBITMQ_URL);
  const channel = await connection.createChannel();

  try {
    if (action === 'stats') {
      console.log('\n=== RabbitMQ Microservices Queue & DLQ Depth ===');
      console.log('Queue Name'.padEnd(30) + 'Main Depth'.padEnd(15) + 'DLQ Depth'.padEnd(15));
      console.log('-'.repeat(60));

      for (const q of KNOWN_QUEUES) {
        let mainCount = 'n/a';
        let dlqCount = '0';

        try {
          const mainStat = await channel.checkQueue(q);
          mainCount = String(mainStat.messageCount);
        } catch {
          // main queue not yet declared
        }

        try {
          const dlqStat = await channel.checkQueue(`${q}.dlq`);
          dlqCount = String(dlqStat.messageCount);
        } catch {
          // DLQ not yet declared
        }

        console.log(q.padEnd(30) + mainCount.padEnd(15) + dlqCount.padEnd(15));
      }
      console.log('\n');
    } else if (action === 'replay') {
      if (!targetQueue) {
        console.error('Error: Please specify the queue name to replay (e.g. shipping-service)');
        process.exit(1);
      }

      const dlqQueue = targetQueue.endsWith('.dlq') ? targetQueue : `${targetQueue}.dlq`;
      const limit = Number(limitArg ?? 50);

      console.log(`Replaying up to ${limit} messages from ${dlqQueue} to exchange ${MAIN_EXCHANGE}...`);

      let replayed = 0;
      for (let i = 0; i < limit; i++) {
        const msg = await channel.get(dlqQueue, { noAck: false });
        if (!msg) {
          break;
        }

        const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
        const originalRoutingKey =
          (headers['x-original-routing-key'] as string) || msg.fields.routingKey || '#';

        const cleanedHeaders = { ...headers };
        delete cleanedHeaders['x-retry-count'];
        delete cleanedHeaders['x-quarantine-reason'];
        delete cleanedHeaders['x-quarantine-error'];
        delete cleanedHeaders['x-quarantine-at'];

        channel.publish(MAIN_EXCHANGE, originalRoutingKey, msg.content, {
          ...msg.properties,
          headers: {
            ...cleanedHeaders,
            'x-replayed-at': new Date().toISOString(),
          },
        });

        channel.ack(msg);
        replayed++;
      }

      console.log(`Success: Replayed ${replayed} messages from ${dlqQueue} back to ${MAIN_EXCHANGE}.`);
    } else if (action === 'purge') {
      if (!targetQueue) {
        console.error('Error: Please specify the queue name to purge');
        process.exit(1);
      }

      const dlqQueue = targetQueue.endsWith('.dlq') ? targetQueue : `${targetQueue}.dlq`;
      const result = await channel.purgeQueue(dlqQueue);
      console.log(`Success: Purged ${result.messageCount} messages from ${dlqQueue}.`);
    }
  } finally {
    await channel.close();
    await connection.close();
  }
}

main().catch((err) => {
  console.error('DLQ Manager Error:', err);
  process.exit(1);
});
