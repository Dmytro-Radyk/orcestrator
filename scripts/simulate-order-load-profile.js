import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const steps = [
  ['GET', '/api/cart'],
  ['POST', '/api/cart/items'],
  ['POST', '/api/checkout/review'],
  ['POST', '/api/checkout/confirm']
];

try {
  const { targets } = JSON.parse(await readFile('config/launch-readiness.json', 'utf8'));
  const { PublicGuard } = await import(pathToFileURL(resolve('src/security/public-guard.mjs')));
  const { securityPolicy } = await import(pathToFileURL(resolve('src/security/policy.mjs')));
  const policy = securityPolicy();
  const { concurrentUsers, orderRps, loadDurationMinutes, spikeMultiplier, spikeMinutes, checkoutTestAttempts } = targets;
  const baseSeconds = loadDurationMinutes * 60;
  const spikeSeconds = spikeMinutes * 60;
  const duration = baseSeconds + spikeSeconds;
  if (![concurrentUsers, baseSeconds, checkoutTestAttempts, policy.publicWindowSeconds, policy.maxNetworkBuckets, policy.globalWindowLimit].every(n => Number.isSafeInteger(n) && n > 0) ||
      !Number.isSafeInteger(spikeSeconds) || spikeSeconds < 0 || duration > 86400 ||
      !Number.isFinite(orderRps) || orderRps <= 0 || !Number.isFinite(spikeMultiplier) || spikeMultiplier < 1) {
    throw Error('Некоректні параметри профілю навантаження');
  }

  const identities = Array.from({ length: Math.min(concurrentUsers, policy.maxNetworkBuckets) }, (_, index) => ({
    remoteAddress: `simulation-user-${index + 1}`
  }));
  const { session, mutation, confirm } = policy.publicLimits;
  const ordersPerIdentity = Math.min(session, Math.floor(mutation / 2), confirm);
  const capacity = Math.min(identities.length * ordersPerIdentity, Math.floor(policy.globalWindowLimit / steps.length));
  const weightAt = seconds => Math.min(seconds, baseSeconds) + Math.max(0, seconds - baseSeconds) * spikeMultiplier;
  let largestWindow = 0;
  for (let start = 0; start < duration; start += policy.publicWindowSeconds) {
    const end = Math.min(start + policy.publicWindowSeconds, duration);
    largestWindow = Math.max(largestWindow, weightAt(end) - weightAt(start));
  }
  // Use the clean reset window and round the rate down so an indivisible request fits.
  const rate = Math.min(orderRps, Math.floor(1000 * capacity / largestWindow) / 1000);
  const attempts = Math.floor(rate * weightAt(duration));
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 100000) {
    throw Error('У межах політики не вдалося побудувати коректну вибірку для симуляції');
  }

  let now = 0;
  let admitted = 0;
  const guard = new PublicGuard({ policy, now: () => now });
  for (let index = 0; index < attempts; index++) {
    const time = index / rate;
    now = Math.floor(1000 * (time < baseSeconds ? time : baseSeconds + (time - baseSeconds) / spikeMultiplier));
    // These identities exist only inside the in-memory limiter, without a network connection.
    const socket = identities[index % identities.length];
    if (steps.every(([method, path]) => guard.check({ method, socket }, path).allowed)) admitted++;
  }
  const number = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 3 });
  const enough = attempts >= checkoutTestAttempts;
  console.log(`Симуляція ліміту: ${concurrentUsers} користувачів, ${loadDurationMinutes} хв + ${spikeMinutes} хв піку. Початковий темп ${number.format(orderRps)}/с узгоджено до ${number.format(rate)}/с, у піку ${number.format(rate * spikeMultiplier)}/с. Допущено ${admitted}/${attempts} оформлень. Мінімум вибірки: ${checkoutTestAttempts}. Перевірено правила допуску в пам’яті.`);
  if (!enough || admitted !== attempts) process.exitCode = 1;
} catch (error) {
  console.log(`Симуляція профілю: ${error.message}`);
  process.exitCode = 2;
}
