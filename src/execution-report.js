export const executionReportInstructions=`У звіті розрізняй результат перевірки та код запуску команди.
Для перевірки коду завершення використовуй kind="exit_code", expectedExitCode та actualExitCode. Очікувана відмова (наприклад, exit 1 при забороні реального запуску) є успішною перевіркою, якщо фактичний код дорівнює очікуваному. Не вмикай реальні продажі або інші зовнішні дії заради exit 0.
Для інших перевірок використовуй kind="assertion", expectedExitCode=null, actualExitCode=null та чесний status. Обов'язкова перевірка, яка справді не пройшла або не виконана, не може бути позначена успішною. Відсутність компонентів майбутніх задач не є провалом поточної задачі; їхні майбутні перевірки позначай required=false, status=not_run.
Якщо перевірку блокує середовище, збережи чернетку, поверни status="blocked" та вкажи у details точну помилку і відсутній компонент. Зберігай команду й результат інших перевірок. Не повторюй ту саму команду, доки передумови не змінилися.
Для локального верифікатора записуй команду тесту окремо від змінних середовища й діагностики. Для Node-проєктів підтримуються npm run test:http, node --test з явними шляхами до файлів tests/*.test.mjs і tests/integration/*.test.mjs, node scripts/test-<назва>-postgres.mjs і node scripts/check-<назва>-browser.mjs за політикою проєкту.
Записуй кожну автоматизовану команду окремим пунктом checks. Перевірки, яким потрібен фізичний пристрій, зовнішнє середовище або ручний журнал, записуй окремими пунктами з конкретною передумовою. Це дозволяє запустити готові автоматичні перевірки, поки решта очікує середовища.
status=completed означає виконання поточної технічної задачі відповідно до уточнень користувача, а не фактичну активацію всього продукту.`;

export function verificationBlockers(task) {
  if(!['failed','blocked'].includes(task.status)||!task.workspace||
    !['AGENT_BLOCKED','CHECKS_BLOCKED','WORKER_FAILED'].includes(task.failure?.code))return [];
  const pending=(task.blockedReport?.checks??[]).filter(check=>check.required!==false&&check.status!=='passed');
  return pending.flatMap(check=>{
    const detail=check.details??'';
    if(/(?:EACCES|EPERM|WSAEACCES).{0,120}(?:127\.0\.0\.1|::1|localhost)|(?:loopback|127\.0\.0\.1|::1|localhost).{0,120}(?:EACCES|EPERM|WSAEACCES)/i.test(detail))
      return [{command:check.command,reason:'Середовище виконавця заблокувало локальний HTTP-сокет'}];
    const missing=detail.match(/\bPOSTGRES_TOOL_REQUIRED:([\w-]+)\b|\bspawn(?:Sync)?\s+([\w.-]+)\s+ENOENT\b/i);
    if(missing)return [{command:check.command,reason:`У середовищі виконавця немає ${missing[1]??missing[2]}`}];
    if(/\bBROWSER_REPORT_MISSING\b/.test(detail)&&/\bnet::ERR_NETWORK_ACCESS_DENIED\b/.test(detail)&&/loopback|127\.0\.0\.1|localhost/i.test(detail))
      return [{command:check.command,reason:'Середовище виконавця заблокувало локальне HTTP-з’єднання браузера'}];
    if(/\bBROWSER_REQUIRED\b|\bBROWSER_START_FAILED:exit=(?:2147483651|0x80000003)\b/i.test(detail)||
      /\b(?:chrome|chromium|msedge)(?:\.exe)?\b.{0,80}\b(?:2147483651|0x80000003)\b/i.test(detail))
      return [{command:check.command,reason:'Середовище виконавця не запустило браузер для перевірки'}];
    return [];
  });
}

export function waitsForVerification(task) {
  const pending=(task.blockedReport?.checks??[]).filter(check=>check.required!==false&&check.status!=='passed');
  return pending.length>0&&verificationBlockers(task).length===pending.length;
}

export function normalizeReportChecks(checks) {
  return checks.map(check=>{
    if(!check||typeof check.command!=='string'||typeof check.details!=='string'||!['passed','failed','not_run'].includes(check.status)||
      check.required!==undefined&&typeof check.required!=='boolean')throw Error('Некоректна перевірка у звіті виконання');
    // Legacy reports without an explicit exit-code assertion retain their status.
    if(check.kind===undefined)return check;
    if(check.kind==='assertion'){
      if(check.expectedExitCode!==null||check.actualExitCode!==null)throw Error('Звичайна перевірка не може підмінятися очікуваним кодом завершення');
      return check;
    }
    if(check.kind!=='exit_code')throw Error('Для перевірки exit code потрібні явні очікуваний і фактичний коди');
    const validCode=code=>Number.isSafeInteger(code)&&code>=0&&code<=0xffffffff;
    if(check.status==='not_run'){
      if(!validCode(check.expectedExitCode)||(check.actualExitCode!==null&&!validCode(check.actualExitCode)))
        throw Error('Для перевірки exit code потрібні явні очікуваний і фактичний коди');
      return check;
    }
    if(!validCode(check.expectedExitCode)||!validCode(check.actualExitCode))throw Error('Для перевірки exit code потрібні явні очікуваний і фактичний коди');
    return {...check,reportedStatus:check.status,status:check.actualExitCode===check.expectedExitCode?'passed':'failed'};
  });
}

export const reportNeedsCorrection=task=>['failed','blocked'].includes(task.status)&&(
  ['WORKER_FAILED','WORKSPACE_CHECK_FAILED'].includes(task.failure?.code)&&task.blockedReport?.status==='completed'||
  task.failure?.code==='CHECKS_BLOCKED'&&Boolean(task.workspace&&task.blockedReport)&&!waitsForVerification(task)||
  task.failure?.code===2&&Boolean(task.workspace&&task.result)&&/^Command failed: git [^\r\n]* diff --cached --check\r?\n?$/.test(task.failure.message??'')&&
  Boolean(task.outputs?.some(o=>o.report?.status==='completed'&&Array.isArray(o.report.checks)&&o.report.checks.every(c=>c.required===false||c.status==='passed')))
);
export const workspaceNeedsResolution=task=>task.status==='blocked'&&task.failure?.code==='WORKSPACE_CONFLICT'&&Boolean(task.workspace&&task.result);
