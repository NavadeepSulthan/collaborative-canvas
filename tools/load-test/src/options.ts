import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';

export interface LoadTestOptions {
  url: string;
  clients: number;
  edits: number;
  rooms: number;
  rate: number;
  observersPerRoom: number;
  workers: number;
  cursorHz: number;
  tenant: string;
  out: string | undefined;
}

const HELP = `
Usage: npm run load-test -- [options]

  --url <http url>            server base URL                (default http://localhost:4000)
  --clients <n>               concurrent editing users       (default 1000)
  --edits <n>                 total edits across all users   (default 100000)
  --rooms <n>                 boards to spread users over    (default 100; 1 = everyone in one board)
  --rate <n>                  edits per second per user      (default 10)
  --observers-per-room <n>    extra read-only clients measuring latency (default 1)
  --workers <n>               load-generator threads         (default: cpus - 4, max 8)
  --cursor-hz <n>             cursor moves per second per user (default 0)
  --tenant <slug>             tenant for all boards          (default loadtest)
  --out <file>                write the JSON report here
`;

export function parseOptions(argv = process.argv.slice(2)): LoadTestOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string', default: 'http://localhost:4000' },
      clients: { type: 'string', default: '1000' },
      edits: { type: 'string', default: '100000' },
      rooms: { type: 'string', default: '100' },
      rate: { type: 'string', default: '10' },
      'observers-per-room': { type: 'string', default: '1' },
      workers: {
        type: 'string',
        default: String(Math.max(1, Math.min(8, availableParallelism() - 4))),
      },
      'cursor-hz': { type: 'string', default: '0' },
      tenant: { type: 'string', default: 'loadtest' },
      out: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  const options: LoadTestOptions = {
    url: values.url.replace(/\/$/, ''),
    clients: positiveInt(values.clients, 'clients'),
    edits: positiveInt(values.edits, 'edits'),
    rooms: positiveInt(values.rooms, 'rooms'),
    rate: positiveNumber(values.rate, 'rate'),
    observersPerRoom: positiveInt(values['observers-per-room'], 'observers-per-room'),
    workers: positiveInt(values.workers, 'workers'),
    cursorHz: Number(values['cursor-hz']),
    tenant: values.tenant,
    out: values.out,
  };
  if (options.rooms > options.clients) throw new Error('--rooms cannot exceed --clients');
  // The server's per-connection token bucket allows 200 msg/s sustained.
  if (options.rate + options.cursorHz > 150)
    throw new Error('--rate + --cursor-hz must stay under the server rate limit');
  return options;
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
}

function positiveNumber(value: string, name: string): number {
  const n = Number(value);
  if (!(n > 0)) throw new Error(`--${name} must be > 0`);
  return n;
}
