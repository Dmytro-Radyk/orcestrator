import { readFile, lstat, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';

export const storefrontAcceptanceId = 'storefront-acceptance';
const evidenceDirectory = 'artifacts/storefront-acceptance';
const auditFile = `${evidenceDirectory}/audit.json`;
const previews = [
  { file: `${evidenceDirectory}/desktop.png`, minWidth: 1024, maxWidth: 4096 },
  { file: `${evidenceDirectory}/mobile.png`, minWidth: 320, maxWidth: 480 }
];

const inside = (root, target) => {
  const rel = relative(root, target);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export function isStorefrontBrief({ name = '', description = '' } = {}) {
  return /інтернет[ -]?магазин|онлайн[ -]?магазин|інтернет[ -]?крамниц|вітрин[аиуою]\s+товар|\b(?:online store|webshop|storefront|e-commerce|ecommerce|phone shop|mobile store)\b/i
    .test(`${name} ${description}`) || /^(?:магазин|крамниця)(?:\s|$)/i.test(name);
}

export const productPlanningInstructions = [
  'ПРОДУКТОВИЙ ТА ІНЖЕНЕРНИЙ СТАНДАРТ:',
  '1. Компактний інженерний план: орієнтир 5–10 зв’язних задач (до 12 для великого вебзастосунку), щоб витрачати токени на якість продукту, а не на роздрібнення.',
  '2. Кожна задача має створювати або вдосконалювати працюючий код, інтерфейс, дані, графіку чи тести. ЗАБОРОНЕНО створювати окремі задачі на організаційні погодження, юридичні/гарантійні регламенти, вибір стеку без коду, договори з постачальниками, маркетинг-плани, пілотний запуск реальних продажів або паперові чеклісти готовності.',
  '3. Якщо проєкт є вебзастосунком або сайтом: з перших задач закладається єдиний цілісний застосунок, який запускається локально однією командою, має сучасний комерційний дизайн, чітку візуальну ієрархію, продуману типографіку й адаптивність для десктопа та мобільних (без «сірих заглушок» і без тривожних технічних банерів поверх контенту).',
  '4. Не блокуй реалізацію через відсутність зовнішніх API-ключів, реальних платежів чи прайсу: використовуй реалістичні стартові дані та повноцінну локальну інтерактивність (акуратна позначка про локальний режим допускається лише в футері чи на кроці підтвердження).'
].join('\n');

export const storefrontPlanningInstructions = [
  'СТАНДАРТ ВІТРИНИ ТА ІНТЕРНЕТ-МАГАЗИНУ (рівень сучасного комерційного магазину, у якому хочеться оформити замовлення):',
  '- Дизайн і UX: цілісний сучасний дизайн із фірмовою шапкою (логотип, живий пошук, категорії/бренди, лічильники обраного, порівняння та кошика), привабливим hero-блоком, швидкими підбірками («Хіти», «Новинки», «Флагмани», «Знижки»), картками товарів із рейтингом, відгуками, ключовими характеристиками, кольоровими swatches, ціною та миттєвими кнопками «У кошик», «Порівняти», «В обране».',
  '- Наповнення каталогу: за відсутності власного прайсу користувача заплануй багатий реалістичний стартовий каталог щонайменше з 12 різних моделей різних брендів (і не менше шести різних моделей навіть для вузької ніші, крім випадків, коли користувач прямо задав інший обсяг), із кількома конфігураціями пам’яті/кольорів, детальними характеристиками, відгуками, комплектацією та супутніми аксесуарами. Жодних заблокованих кнопок «У кошик» чи жовтих тривожних плашок «ТЕСТОВІ ДАНІ» на кожній картці.',
  '- Зображення товарів: кожна модель і колір повинні мати власні унікальні, впізнавані, деталізовані локальні зображення, які завантажуються за локальними URL (2–3 ракурси у картці товару: загальний вигляд/екран, фірмовий блок камер, деталі корпусу). СУВОРО ЗАБОРОНЕНО використовувати однакові прямокутники-заглушки або одне зображення для різних моделей — кожна модель повинна візуально відрізнятися формою камер, кольором корпусу, екраном і деталями.',
  '- Повний сценарій покупки: живий пошук і фільтри (бренд, бюджет, пам’ять, ключові характеристики, наявність) + сортування -> картка товару з перемиканням пам’яті/кольору й галереєю -> порівняння моделей із зображеннями, ціною й режимом «Тільки відмінності» -> обране -> інтерактивний кошик (кількість, промокод, підсумок) -> оформлення замовлення з доставкою, локальною оплатою та підтвердженням номера замовлення.',
  `- Фінальна задача: використай зарезервований ID ${storefrontAcceptanceId} (залиши для неї один слот із 30) для робочого локального перегляду, браузерного приймання та візуального аудиту (а не паперового звіту).`
].join('\n');

export function withStorefrontAcceptance(plan) {
  const dependents = new Set(plan.tasks.flatMap(task => task.dependsOn));
  const named = plan.tasks.find(task => task.id === storefrontAcceptanceId);
  let existing = (named && !dependents.has(named.id) ? named : null) ??
    plan.tasks.findLast(task => !dependents.has(task.id) && task.skills.includes('testing') && task.skills.includes('review'));
  let implementation = plan.tasks.filter(task => task !== existing);
  if (named && dependents.has(named.id)) {
    implementation = implementation.map(task => ({
      ...task,
      dependsOn: task.dependsOn.filter(dep => dep !== storefrontAcceptanceId)
    })).filter(task => task.id !== storefrontAcceptanceId);
    existing = named;
  }
  if (!existing && implementation.length >= 30) {
    const leaf = implementation.findLast(task => !dependents.has(task.id)) ?? implementation.at(-1);
    existing = leaf;
    implementation = implementation.filter(task => task !== leaf);
  }
  const catalogTask = implementation.find(task => /каталог|вітрин|storefront|catalog/i.test(task.title)) ??
    implementation.find(task => task.skills.includes('frontend'));
  if (catalogTask) {
    const index = implementation.indexOf(catalogTask);
    const mediaCriterion = 'Локальний перегляд каталогу містить багатий погоджений або реалістичний стартовий асортимент (12+ різних моделей різних брендів або обсяг користувача) та унікальні деталізовані зображення товарів, які завантажуються за локальними URL без однакових заглушок.';
    const acceptanceCriteria = catalogTask.acceptanceCriteria.length === 30 || catalogTask.acceptanceCriteria.includes(mediaCriterion)
      ? catalogTask.acceptanceCriteria : [...catalogTask.acceptanceCriteria, mediaCriterion];
    implementation[index] = { ...catalogTask, acceptanceCriteria,
      ...(acceptanceCriteria.length === 30 && !acceptanceCriteria.includes(mediaCriterion) &&
        catalogTask.prompt.length + mediaCriterion.length < 12000 ? { prompt: `${catalogTask.prompt}\n${mediaCriterion}` } : {}) };
  }
  const prerequisite = new Set(implementation.flatMap(task => task.dependsOn));
  const implIds = new Set(implementation.map(task => task.id));
  const dependencies = new Set([
    ...implementation.filter(task => !prerequisite.has(task.id)).map(task => task.id),
    ...(existing?.dependsOn ?? []).filter(dep => implIds.has(dep))
  ]);
  const promptParts = [
    'Запусти з поточної версії той самий локальний перегляд, який відкриватиме користувач. Перевір і дошліфуй візуальний дизайн, наповнення каталогу, унікальні зображення кожної моделі та повний сценарій покупки в межах узгодженого плану.',
    'Виконай браузерний smoke- та візуальний тест каталогу, картки товару, порівняння, кошика й оформлення замовлення. Перевір, що всі зображення завантажилися (naturalWidth > 0) і різні моделі НЕ використовують однаковий плейсхолдер, ціни та перемикання конфігурацій працюють, кошик й оформлення не заблоковані, а на телефоні (390px) немає горизонтального виходу за межі екрана.',
    `Додай у files PNG-знімки справді запущеного браузера: ${previews.map(item => item.file).join(', ')} (ширини 1280 і 390 px) та JSON-аудит ${auditFile} формату {"modelsCount":12,"uniqueProductImages":12,"brokenImages":0,"mobileHorizontalOverflow":false,"checkoutFlowPassed":true}. У checks запиши фактичну обов’язкову браузерну команду з кодом 0; назва команди або її скрипта має містити browser, playwright чи webdriver. Залиш коротку команду для запуску локального перегляду в підсумку. Якщо перегляд або потрібні докази недоступні, поверни status=blocked з причиною.`
  ];
  if (existing?.prompt) {
    const baseLen = promptParts.join('\n').length + 1;
    const room = 12000 - baseLen;
    if (room > 40) promptParts.push(existing.prompt.slice(0, room));
  }
  return { ...plan, tasks: [...implementation, {
    id: storefrontAcceptanceId,
    title: 'Браузерне приймання та візуальна якість вітрини',
    prompt: promptParts.join('\n').slice(0, 12000),
    skills: ['frontend', 'testing', 'browser'],
    dependsOn: [...dependencies],
    acceptanceCriteria: [
      'У локальному перегляді каталог містить багатий вибір моделей різних брендів, унікальні деталізовані зображення кожної моделі завантажуються без помилок, а дизайн виглядає як сучасний комерційний магазин.',
      'На десктопі (1280px) і телефоні (390px) картки, фільтри, картка товару, порівняння (з режимом відмінностей), кошик і оформлення замовлення працюють без збоїв і без горизонтального переповнення.',
      'Збережено два браузерні PNG-знімки, звіт аудиту та фактичний успішний результат браузерного тесту.',
      ...(existing?.acceptanceCriteria ?? []).slice(0, 27)
    ]
  }] };
}

const normalizeRelPath = value => typeof value === 'string' ? value.replaceAll('\\', '/').replace(/^\.\//, '') : '';

export async function verifyStorefrontEvidence(report, cwd) {
  if (!report?.checks?.some(check => check.required !== false && check.status === 'passed' &&
      check.kind === 'exit_code' && check.expectedExitCode === 0 && check.actualExitCode === 0 &&
      /browser|playwright|webdriver/i.test(check.command))) return false;
  const reportedFiles = new Set((report.files ?? []).map(normalizeRelPath));
  const rootReal = await realpath(cwd);
  const buffers = [];
  for (const { file, minWidth, maxWidth } of previews) {
    if (!reportedFiles.has(file)) return false;
    const path = join(cwd, file);
    const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!info?.isFile() || info.size < 48 || info.size > 8 * 1024 * 1024) return false;
    const actual = await realpath(path);
    if (!inside(rootReal, actual)) return false;
    const png = await readFile(actual);
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        png.toString('ascii', 12, 16) !== 'IHDR') return false;
    const width = png.readUInt32BE(16);
    if (width < minWidth || width > maxWidth || png.readUInt32BE(20) < 360) return false;
    buffers.push(png);
  }
  if (buffers.length === 2 && buffers[0].equals(buffers[1])) return false;
  const auditPath = join(cwd, auditFile);
  const auditInfo = await lstat(auditPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (auditInfo) {
    if (!auditInfo.isFile() || auditInfo.size > 512 * 1024) return false;
    const actualAudit = await realpath(auditPath);
    if (!inside(rootReal, actualAudit)) return false;
    let audit;
    try { audit = JSON.parse(await readFile(actualAudit, 'utf8')); } catch { return false; }
    if (!audit || typeof audit !== 'object') return false;
    if (!Number.isFinite(audit.modelsCount) || audit.modelsCount < 6) return false;
    if (!Number.isFinite(audit.uniqueProductImages) || audit.uniqueProductImages < 6) return false;
    if (audit.brokenImages !== 0) return false;
    if (audit.mobileHorizontalOverflow !== false) return false;
    if (audit.checkoutFlowPassed !== true) return false;
  }
  return true;
}
