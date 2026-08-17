/** `npm run doctor` - print what this machine can actually do, and why not. */
import { config } from './config.js';
import { ColmapLocalProvider } from './providers/colmapLocal.js';
import { ReplicateProvider } from './providers/replicate.js';
import { TrellisLocalProvider } from './providers/trellisLocal.js';
import { KaggleGpuProvider } from './providers/kaggleGpu.js';

const providers = [new TrellisLocalProvider(), new KaggleGpuProvider(),
                   new ColmapLocalProvider(), new ReplicateProvider()];

console.log('SCANFORGE environment check');
console.log('  data dir :', config.dataDir);
console.log('  python   :', config.pythonBin);
console.log('  default  :', config.defaultProvider);
console.log('');

let anyAvailable = false;
for (const provider of providers) {
  const status = await provider.probe();
  anyAvailable ||= status.available;
  console.log(`${status.available ? '✅' : '❌'} ${status.id} — ${status.label}`);
  if (status.reason) console.log(`   ${status.reason}`);
  if (status.details) {
    for (const [key, value] of Object.entries(status.details)) {
      console.log(`   ${key}: ${JSON.stringify(value)}`);
    }
  }
  console.log('');
}

if (!anyAvailable) {
  console.log('No reconstruction provider is available. Install COLMAP (brew install colmap)');
  console.log('and run `npm run setup:pipeline`, or set REPLICATE_API_TOKEN.');
  process.exit(1);
}
