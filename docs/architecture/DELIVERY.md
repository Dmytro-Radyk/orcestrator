# Етапи реалізації та критерії готовності

Статус: план після проєктування. [Навігація](README.md).

## 1. Перевірка поточного прототипу

Прототип підтверджує основні сценарії на демонстраційних агентах і локальних тестових процесах. Він не є завершеною реалізацією описаних гарантій.

| Наявна конструкція | Обмеження | Архітектурна зміна |
| --- | --- | --- |
| Один `Engine` | Стани, scheduling, routing і invocation зчеплені | Виділити прикладні сценарії та ports |
| Один JSON state | Один власник, немає транзакцій jobs/events | SQLite, міграції, outbox, durable jobs |
| Загальний provider interface | Не розрізняє текстову модель і повноцінного CLI-агента | ModelClient, AgentRuntime та capabilities |
| Збіг навичок | Не перевіряє весь набір потрібних можливостей | Hard constraints + оцінка + пояснення |
| Ліміти одного Run | Немає глобального/provider бюджету | Ієрархічні ресурсні reservations |
| Спільний каталог CLI | Серіалізація захищає від частини гонок, обмежує паралельність | Workspace на writer та контрольована інтеграція |
| Фінальний статус cancel до завершення процесів | Статус не доводить припинення зовнішніх дій | Cancellation intent, acknowledgment і recovery |
| `interrupted` після рестарту | Немає звірки зовнішньої сесії або retry classification | Lease, inspect, outcome reconciliation |
| Схвалення як boolean | Немає прив'язки до hashes/версії action | Окремі Approval та Review |
| Team failure перезапускає всю задачу | Може повторювати успішні побічні ефекти інших учасників | Invocation-level результати, partial failure policy |

## 2. Порядок роботи

### Етап 1 — домен, контракти, стійкий стан

Описати schemas і state machines; створити базові workspace-пакети, SQLite migrations, транзакції, revisions, jobs/events/outbox. Реалізувати fake runtime та керований clock. Перенести сценарій «проєкт → одна задача → результат».

Критерій: дубльована команда не створює другий Run; restart після кожної критичної межі не втрачає стан; старий lease не приймає результат; зміна профілю не змінює snapshot запуску.

### Етап 2 — scheduler, worker, API та CLI

Винести execution у worker; додати resource pools, heartbeat, stop confirmation, API model adapters та CLI backend. Додати capabilities, timeout/error classification і мінімальний ContextBuilder. Реальні paid smoke tests — окремий opt-in з тестовим проєктом і малими лімітами.

Критерій: є паралельний запуск через API і CLI; API лишається доступним під час зависання CLI; ліміти не перевищуються на рівні сервера й провайдера; локальний UI/CLI клієнт не може викликати внутрішнє завершення job.

### Етап 3 — команди, делегування та приймання

Routing hard constraints; parallel candidates, pipeline, implement–review; версії плану, subtree cancellation, join policies, approvals і budget ledger. Інші стратегії додаються через той самий контракт.

Критерій: батько звільняє слот під час очікування дітей; цикли очікування відкидаються; діти не розширюють права; reviewer перевіряє конкретний hash; retry не повторює прийнятий side effect іншого учасника; exhaustion бюджету має зрозумілий стан.

### Етап 4 — локальна панель керування

Створення/редагування проєктів, реєстр агентів, підключення, recommendation preview, план, екран запуску, дерево субагентів, журнал, usage, погодження, artifacts. Спочатку довести один повний користувацький сценарій, потім решту екранів.

Критерій: користувач створює змішану команду без редагування JSON; бачить причини призначення; змінює майбутній склад без впливу на активний snapshot; reconnect відновлює стан без дублювання команд; недоступні capabilities не показані як робочі кнопки.

### Етап 5 — паралельне редагування та перевірка коду

Git workspaces, diff artifacts, інтеграційні задачі, test reports, правила publish/merge. Підтримати некодові artifacts тим самим механізмом приймання.

Критерій: два редактори не змінюють один каталог; інтеграційний конфлікт не губить жодної гілки; перевіряється об'єднаний результат; невідомий стан старого writer не дозволяє перепризначення його каталогу.

### Етап 6 — розширені можливості

MCP, agent tool loop, пам'ять/RAG, benchmarks і evaluation routing, debate/vote, контрольований fallback, повний cost reporting, шаблони, віддалені workers. PostgreSQL, командний доступ і desktop-оболонка — за підтвердженої потреби.

Критерій: кожна можливість має capability contract, domain behavior, тести відмов і видимий стан UI. Наявність кнопки або provider adapter без наскрізного сценарію не означає готову функцію.

## 3. Матриця перевірок

| Рівень | Обов'язкові сценарії |
| --- | --- |
| Domain unit | Стани, DAG + wait cycles, inheritance прав, routing constraints, join policies |
| Adapter contract | Streaming, часткові/невалідні відповіді, usage unknown, cancellation, version mismatch |
| Persistence | Concurrent claim, rollback, revision conflict, duplicate command, migration/backup |
| Recovery | Падіння до/після dispatch, stale worker, late result, orphan artifact, unknown side effect |
| Budget/resource | Одночасні reservations, неповне usage, rate limit, shared CLI quota, GPU contention |
| Workspace | Writer quarantine, зміни користувача, конфлікти integration, path boundaries |
| Security boundaries | Секрети в логах, tool permissions, cross-project artifacts, worker impersonation |
| End-to-end | Створення, команда, run, subagents, review, edit active plan, reconnect, cancel |

Навантажувальні цілі спочатку вимірюються на цільовому комп'ютері. Не фіксуємо необґрунтовані обіцянки про сотні одночасних агентів: обмеження провайдера, GPU і швидкість диска суттєво різняться. Acceptance test першого релізу має включати кілька одночасних Run, завислий runtime та безперервну доступність API.

## 4. Рішення, які ще можна змінити

| Питання | Робоче припущення | Коли уточнювати |
| --- | --- | --- |
| Формат інтерфейсу | Локальна вебпанель; desktop shell пізніше | Перед етапом UI |
| Головний тип проєктів | Код плюс універсальні artifacts | Перед набором перших шаблонів |
| ОС | Windows спочатку, Linux через ports | Перед runtime packaging |
| Реальні провайдери/моделі | Конфігурований каталог, без hardcoded рейтингу | Перед paid smoke tests і routing eval |
| Автономність | Збалансована, налаштовувана для проєкту | Перед UI workflow і tool execution |
| Кілька користувачів | Один локальний оператор | Перед remote deployment |

Ці припущення дозволяють деталізувати фундамент зараз. Вони не вимагають установки служб, платних запитів або зміни доступу до зовнішніх акаунтів на етапі архітектури.
