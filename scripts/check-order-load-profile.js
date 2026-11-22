import { readFile } from 'node:fs/promises';

const readConfig = async name => JSON.parse(await readFile(`config/${name}.json`, 'utf8'));

try {
  const [{ targets }, policy] = await Promise.all([readConfig('launch-readiness'), readConfig('security')]);
  const { concurrentUsers, orderRps, loadDurationMinutes, spikeMultiplier, spikeMinutes, checkoutSuccessRate } = targets;
  const windowSeconds = policy.publicWindowSeconds;
  const capacity = Math.min(policy.globalWindowLimit,
    Math.min(concurrentUsers, policy.maxNetworkBuckets) * policy.publicLimits.confirm);
  const baseSeconds = loadDurationMinutes * 60;
  const totalSeconds = baseSeconds + spikeMinutes * 60;
  if (![windowSeconds, concurrentUsers, capacity, baseSeconds, totalSeconds].every(n => Number.isSafeInteger(n) && n > 0) ||
      totalSeconds > 86400 || totalSeconds < baseSeconds || !Number.isFinite(orderRps) || orderRps <= 0 ||
      !Number.isFinite(spikeMultiplier) || spikeMultiplier < 1 || !(checkoutSuccessRate > 0 && checkoutSuccessRate <= 1)) {
    throw Error('invalid profile');
  }

  let requested = 0, admitted = 0;
  const cumulativeOrders = seconds => Math.floor(
    orderRps * (Math.min(seconds, baseSeconds) + Math.max(0, seconds - baseSeconds) * spikeMultiplier));
  for (let start = 0; start < totalSeconds; start += windowSeconds) {
    const orders = cumulativeOrders(Math.min(start + windowSeconds, totalSeconds)) - cumulativeOrders(start);
    requested += orders;
    admitted += Math.min(capacity, orders);
  }
  if (!Number.isSafeInteger(requested) || requested === 0) throw Error('invalid order count');
  const share = new Intl.NumberFormat('uk-UA', { style: 'percent', maximumFractionDigits: 1 });
  const possible = admitted / requested >= checkoutSuccessRate;
  console.log(`Навіть за окремої адреси для кожного з ${concurrentUsers} користувачів ліміт магазину дозволяє щонайбільше ${admitted} із ${requested} підтверджень (${share.format(admitted / requested)}) за повний профіль із чистим вікном. Ціль — ${share.format(checkoutSuccessRate)}. Це розрахунок допуску запитів, швидкодію сервера він не вимірює.`);
  if (!possible) process.exitCode = 1;
} catch {
  console.log('Не вдалося розрахувати профіль навантаження. Перевірте параметри в config/launch-readiness.json і config/security.json.');
  process.exitCode = 2;
}
