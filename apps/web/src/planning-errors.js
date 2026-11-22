export function planningErrorMessage(error,kind='plan') {
  const message=typeof error==='string'?error:error?.message??'Не вдалося виконати запит';
  if(error?.name==='TimeoutError'||error?.code==='PLANNING_TIMEOUT'||/operation was aborted due to timeout/i.test(message))
    return `${kind==='plan'?'Планування':'AI-запит'} не завершилося за відведений час. Попередні дані залишилися в майстрі. Спробуйте повторити запит або оберіть іншого керівника.`;
  if(error?.code==='METADATA_TIMEOUT'||/Discovery завершено|Metadata timeout|Не вдалося вчасно перевірити доступ до Codex/i.test(message))
    return 'Не вдалося вчасно перевірити доступ до Codex. Включена квота не підтверджена, тому виклик зупинено. Повторіть запит або оновіть «Підключення».';
  return message;
}
