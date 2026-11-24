import { storefrontDomainProfile } from './profiles/storefront/quality.js';

export const productPlanningInstructions = [
  'ПРОДУКТОВИЙ ТА ІНЖЕНЕРНИЙ СТАНДАРТ:',
  '1. Компактний інженерний план: орієнтир 5–10 зв’язних задач (до 12 для великого вебзастосунку), щоб витрачати токени на якість продукту, а не на роздрібнення.',
  '2. Кожна задача має створювати або вдосконалювати працюючий код, інтерфейс, дані, графіку чи тести. ЗАБОРОНЕНО створювати окремі задачі на організаційні погодження, юридичні/гарантійні регламенти, вибір стеку без коду, договори з постачальниками, маркетинг-плани, пілотний запуск реальних продажів або паперові чеклісти готовності.',
  '3. Якщо проєкт є вебзастосунком або сайтом: з перших задач закладається єдиний цілісний застосунок, який запускається локально однією командою, має сучасний комерційний дизайн, чітку візуальну ієрархію, продуману типографіку й адаптивність для десктопа та мобільних (без «сірих заглушок» і без тривожних технічних банерів поверх контенту).',
  '4. Не блокуй реалізацію через відсутність зовнішніх API-ключів, реальних платежів чи прайсу: використовуй реалістичні стартові дані та повноцінну локальну інтерактивність (акуратна позначка про локальний режим допускається лише в футері чи на кроці підтвердження).'
].join('\n');

export const defaultDomainProfiles = Object.freeze([storefrontDomainProfile]);

export function resolveDomainProfile(input, profiles = defaultDomainProfiles) {
  return profiles.find(profile => profile.matchesBrief?.(input)) ?? null;
}

export function findAcceptanceProfile(taskId, profiles = defaultDomainProfiles) {
  return profiles.find(profile => profile.acceptanceTaskId && profile.acceptanceTaskId === taskId) ?? null;
}

export function applyAcceptanceRoutingNeed(taskId, need = {}, profiles = defaultDomainProfiles) {
  return findAcceptanceProfile(taskId, profiles)
    ? { ...need, tools: true, workspaceWrite: true }
    : need;
}

export function resolveIsolatedCompanionFile(file, profiles = defaultDomainProfiles) {
  for (const profile of profiles) {
    const companion = profile.isolatedCheckCompanion?.(file);
    if (companion) return companion;
  }
  return null;
}
