export const storefrontAcceptanceId = 'storefront-acceptance';

export function isStorefrontBrief({ name = '', description = '', idea } = {}) {
  return /інтернет[ -]?магазин|онлайн[ -]?магазин|інтернет[ -]?крамниц|вітрин[аиуою]\s+товар|\b(?:online store|webshop|storefront|e-commerce|ecommerce|phone shop|mobile store)\b/i
    .test(`${name} ${description} ${idea?.summary ?? ''}`) || /^(?:магазин|крамниця|книгарня)(?:[\s.!?]|$)/i.test(name.trim());
}

export const storefrontPlanningInstructions = [
  'СТАНДАРТ ВІТРИНИ ТА ІНТЕРНЕТ-МАГАЗИНУ (рівень сучасного комерційного магазину, у якому хочеться оформити замовлення):',
  '- Дизайн і UX: цілісний сучасний дизайн із фірмовою шапкою (логотип, живий пошук, категорії/бренди, лічильники обраного, порівняння та кошика), привабливим hero-блоком, швидкими підбірками («Хіти», «Новинки», «Флагмани», «Знижки»), картками товарів із рейтингом, відгуками, ключовими характеристиками, кольоровими swatches, ціною та миттєвими кнопками «У кошик», «Порівняти», «В обране».',
  '- Наповнення каталогу: за відсутності власного прайсу користувача заплануй багатий реалістичний стартовий каталог щонайменше з 12 різних моделей різних брендів (і не менше шести різних моделей навіть для вузької ніші, крім випадків, коли користувач прямо задав інший обсяг), із кількома конфігураціями пам’яті/кольорів, детальними характеристиками, відгуками, комплектацією та супутніми аксесуарами. Жодних заблокованих кнопок «У кошик» чи жовтих тривожних плашок «ТЕСТОВІ ДАНІ» на кожній картці.',
  '- Зображення товарів: кожна модель і колір повинні мати власні унікальні, впізнавані, деталізовані локальні зображення, які завантажуються за локальними URL (2–3 ракурси у картці товару: загальний вигляд/екран, фірмовий блок камер, деталі корпусу). СУВОРО ЗАБОРОНЕНО використовувати однакові прямокутники-заглушки або одне зображення для різних моделей — кожна модель повинна візуально відрізнятися формою камер, кольором корпусу, екраном і деталями.',
  '- Повний сценарій покупки: живий пошук і фільтри (бренд, бюджет, пам’ять, ключові характеристики, наявність) + сортування -> картка товару з перемиканням пам’яті/кольору й галереєю -> порівняння моделей із зображеннями, ціною й режимом «Тільки відмінності» -> обране -> інтерактивний кошик (кількість, промокод, підсумок) -> оформлення замовлення з доставкою, локальною оплатою та підтвердженням номера замовлення.',
  `- Фінальна задача: використай зарезервований ID ${storefrontAcceptanceId} (залиши для неї один слот із 30) для робочого локального перегляду, браузерного приймання та візуального аудиту (а не паперового звіту).`
].join('\n');

export function storefrontPlanningAddendum(input) {
  const shortStorefront = !input.interview?.some(item => item.answer?.trim()) &&
    input.description.trim().split(/\s+/).length <= 3 &&
    !/docker|postgres|sqlite|mysql|backend|\bssr\b|wordpress|woocommerce|shopify|сервер|база|оплата/i.test(input.description);
  return `${storefrontPlanningInstructions}\n${shortStorefront
    ? 'Опис задає лише тему. Для цього короткого запиту пріоритет має компактний статичний прототип із локальними даними та тестовим оформленням. Плануй до чотирьох задач разом із браузерним прийманням. Docker, зовнішня БД, адмінпанель та інтеграція оплати поза цим обсягом. Припущення з концепції не є новими вимогами користувача.\n'
    : ''}`;
}

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
    'Збережи локальну збірку, що відкривається кореневим index.html (dist, build, out, apps/web/dist, apps/web, public або корінь). Включи всі потрібні локальні файли збірки до files, якщо вони ігноруються Git.',
    'Додай стабільні атрибути на реальні елементи вітрини: data-product-model=ID моделі на видимій картці з img, кнопки data-storefront-compare і data-storefront-add у картці. ID стабільний для різних конфігурацій однієї моделі, містить лише латиницю, цифри, крапку, підкреслення або дефіс. У головній навігації додай data-storefront-compare-open і data-storefront-cart.',
    'У порівнянні познач видимі заголовки data-compared-model=ID, перемикач data-storefront-differences з aria-pressed, однакові рядки data-comparison-same, відмінні рядки data-comparison-different. У режимі відмінностей залишай видимими характеристики з різними значеннями в комірках (td, role=cell або role=gridcell). У кошику додай data-cart-model=ID і data-storefront-checkout, у формі оформлення — data-checkout-form.',
    'Оркестратор сам відкриє локальну збірку у Chromium на 1280 і 390 px, перевірить 12 різних моделей, локальні фото, порівняння, мобільну ширину, кошик і форму оформлення та збереже власні знімки й результати. Не генеруй докази від імені верифікатора.'
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
      'Незалежна перевірка оркестратора пройшла на точній версії збірки та зберегла два знімки й аудит.',
      ...(existing?.acceptanceCriteria ?? []).slice(0, 27)
    ]
  }] };
}

export const storefrontDomainProfile = Object.freeze({
  id: 'storefront',
  acceptanceTaskId: storefrontAcceptanceId,
  matchesBrief: isStorefrontBrief,
  planningAddendum: storefrontPlanningAddendum,
  normalizePlan: withStorefrontAcceptance,
  singleRuntimeError: 'Призначте одного виконавця для браузерного приймання вітрини',
  launchRuntimeError: 'Для браузерного приймання потрібен один виконавець із браузерними інструментами й доступом до запису',
  isolatedLeaseError: 'Приймання вітрини потребує ізольованої робочої копії.',
  auditEventType: 'task.storefront_audit',
  retryEventType: 'task.storefront_evidence_retry',
  retryMessage: 'Виконавцю передано дефекти незалежної браузерної перевірки.',
  formatAuditSummary(audit) {
    return audit.surfaces?.map(({ width, models, uniqueImages }) => `${width} px · Моделі: ${models} · Унікальні фото: ${uniqueImages}`).join('\n');
  },
  isolatedCheckCompanion(file) {
    return file === 'scripts/test-storefront-postgres.mjs' ? 'src/server.mjs' : null;
  }
});
