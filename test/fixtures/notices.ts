// Deterministic, realistic Airbrake v4 notice-list fixture used to measure
// (and guard) the size of tool results. Shapes mirror what hosted Airbrake
// returns from GET /api/v4/projects/:pid/groups/:gid/notices: each notice
// carries a full backtrace plus context/environment/session/params.

export const FIXTURE_GROUP_ID = '4338045234182207507';
const BACKTRACE_FRAMES = 30;

const FRAME_FILES = [
  '/app/node_modules/express/lib/router/layer.js',
  '/app/node_modules/express/lib/router/index.js',
  '/app/src/controllers/orders_controller.ts',
  '/app/src/services/payment_service.ts',
  '/app/src/repositories/order_repository.ts',
  '/app/node_modules/pg/lib/client.js',
];
const FRAME_FUNCTIONS = ['handle', 'next', 'process_params', 'createOrder', 'charge', 'query'];

interface FixtureFrame {
  file: string;
  function: string;
  line: number;
  column: number;
  code: Record<string, string>;
}

function frame(noticeIndex: number, depth: number): FixtureFrame {
  const line = 40 + ((noticeIndex * 7 + depth * 13) % 400);
  return {
    file: FRAME_FILES[depth % FRAME_FILES.length]!,
    function: FRAME_FUNCTIONS[depth % FRAME_FUNCTIONS.length]!,
    line,
    column: 5 + (depth % 20),
    code: {
      [String(line - 1)]: '    const result = await this.repository.save(order);',
      [String(line)]: '    if (!result.ok) throw new PaymentDeclinedError(result.reason);',
      [String(line + 1)]: '    return result.value;',
    },
  };
}

function buildNotice(index: number): Record<string, unknown> {
  const id = (4338045208751454778n + BigInt(index)).toString();
  return {
    id,
    projectId: 42,
    groupId: FIXTURE_GROUP_ID,
    createdAt: new Date(Date.UTC(2026, 10, 1, 12, 0, index)).toISOString(),
    errors: [
      {
        type: 'PaymentDeclinedError',
        message: `card declined for order ord_${100000 + index}: insufficient_funds`,
        backtrace: Array.from({ length: BACKTRACE_FRAMES }, (_, d) => frame(index, d)),
      },
    ],
    context: {
      environment: 'production',
      severity: 'error',
      hostname: `web-${index % 4}.prod.internal`,
      url: `https://shop.example.com/api/orders/${100000 + index}/pay`,
      httpMethod: 'POST',
      route: '/api/orders/:id/pay',
      component: 'orders',
      action: 'pay',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      userAddr: `203.0.113.${index % 255}`,
      version: '3.14.2',
      revision: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      language: 'node/20.18.0',
      notifier: { name: 'airbrake-js/node', version: '2.1.8', url: 'https://github.com/airbrake' },
      user: { id: String(9000 + index), email: `user${index}@example.com`, name: `User ${index}` },
    },
    environment: {
      NODE_ENV: 'production',
      PORT: '8080',
      REGION: 'eu-west-1',
      HOSTNAME: `web-${index % 4}`,
    },
    session: { cart_id: `cart_${index}`, locale: 'en-GB', ab_bucket: 'checkout-v2' },
    params: {
      order_id: String(100000 + index),
      amount: 4999 + index,
      currency: 'EUR',
      payment_method: 'card',
      items: [
        { sku: 'SKU-1001', qty: 1 },
        { sku: 'SKU-2002', qty: 2 },
      ],
    },
  };
}

/** A notices-list page as Airbrake returns it: `{ notices, count, page }`. */
export function buildNoticesPage(perPage: number, total = 500): Record<string, unknown> {
  return {
    notices: Array.from({ length: perPage }, (_, i) => buildNotice(i)),
    count: total,
    page: 1,
  };
}
