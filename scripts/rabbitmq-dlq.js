/**
 * Administrative Dead Letter Queue (DLQ) Manager
 *
 * Usage:
 *   node scripts/rabbitmq-dlq.js stats
 *   node scripts/rabbitmq-dlq.js replay <queue> [limit]
 *   node scripts/rabbitmq-dlq.js purge <queue>
 */
const path = require('path');
const http = require('http');

let amqp;
try {
  amqp = require('amqplib');
} catch {
  try {
    amqp = require(path.resolve(__dirname, '../libs/rabbitmq/node_modules/amqplib'));
  } catch {
    amqp = require(path.resolve(__dirname, './libs/rabbitmq/node_modules/amqplib'));
  }
}

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const RABBITMQ_API = process.env.RABBITMQ_API || 'http://localhost:15672';
const MAIN_EXCHANGE = process.env.RABBITMQ_EXCHANGE || 'commerce.events';
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

function fetchQueuesFromApi() {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from('guest:guest').toString('base64');
    const req = http.get(`${RABBITMQ_API}/api/queues`, {
      headers: { Authorization: `Basic ${auth}` },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
  });
}

async function main() {
  const [action, targetQueue, limitArg] = process.argv.slice(2);

  if (!action || !['stats', 'replay', 'purge'].includes(action)) {
    console.log(`
RabbitMQ Dead Letter Queue Manager
----------------------------------
Usage:
  npm run dlq:stats
  npm run dlq:replay <queue-name> [max-messages]
  npm run dlq:purge <queue-name>

Examples:
  npm run dlq:stats
  node scripts/rabbitmq-dlq.js replay shipping-service 50
  node scripts/rabbitmq-dlq.js purge shipping-service
`);
    process.exit(0);
  }

  if (action === 'stats') {
    try {
      const allQueues = await fetchQueuesFromApi();
      const queueMap = new Map(allQueues.map(q => [q.name, q]));

      console.log('\n========================================================================');
      console.log('🐰  RabbitMQ Microservices Queue & Dead Letter Queue (DLQ) Status');
      console.log('========================================================================');
      console.log('Queue Name'.padEnd(30) + 'Main Depth'.padEnd(15) + 'DLQ Depth'.padEnd(15) + 'Status');
      console.log('-'.repeat(72));

      for (const q of KNOWN_QUEUES) {
        const mainQueue = queueMap.get(q);
        const dlqQueue = queueMap.get(`${q}.dlq`);

        const mainCount = mainQueue ? String(mainQueue.messages) : 'not declared';
        const dlqCount = dlqQueue ? String(dlqQueue.messages) : '0';
        const status = (dlqQueue && dlqQueue.messages > 0) ? '⚠️ HAS POISON MSGS' : '🟢 HEALTHY';

        console.log(q.padEnd(30) + mainCount.padEnd(15) + dlqCount.padEnd(15) + status);
      }
      console.log('========================================================================\n');
      return;
    } catch {
      // Fallback if HTTP API not reachable
      console.log('Connecting via AMQP protocol...');
    }
  }

  console.log(`Connecting to RabbitMQ at ${RABBITMQ_URL}...`);
  const connection = await amqp.connect(RABBITMQ_URL);
  const channel = await connection.createChannel();

  try {
    if (action === 'replay') {
      if (!targetQueue) {
        console.error('Error: Please specify the queue name to replay (e.g. shipping-service)');
        process.exit(1);
      }

      const dlqQueue = targetQueue.endsWith('.dlq') ? targetQueue : `${targetQueue}.dlq`;
      const limit = Number(limitArg || 50);

      console.log(`Replaying up to ${limit} messages from ${dlqQueue} to exchange ${MAIN_EXCHANGE}...`);

      let replayed = 0;
      for (let i = 0; i < limit; i++) {
        const msg = await channel.get(dlqQueue, { noAck: false });
        if (!msg) {
          break;
        }

        const headers = msg.properties.headers || {};
        const originalRoutingKey = headers['x-original-routing-key'] || msg.fields.routingKey || '#';

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
