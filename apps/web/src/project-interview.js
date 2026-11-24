export const interviewTopics = {
  audience: 'Аудиторія',
  goal: 'Мета й пріоритет',
  design: 'Дизайн і враження',
  structure: 'Структура й навігація',
  features: 'Функції першої версії',
  content: 'Контент і дані'
};

const starter = {
  audience: 'Хто буде користуватися продуктом і з якою потребою вони приходять?',
  goal: 'Що людина має зробити найпростіше і що для тебе буде ознакою вдалої першої версії?',
  design: 'Якого враження ти хочеш від дизайну? Що подобається або заважає в схожих продуктах?',
  structure: 'Що людина має побачити спочатку і як їй дістатися до основної дії?',
  features: 'Які функції потрібні з першого запуску, а що можна додати пізніше?',
  content: 'Які тексти, зображення або дані вже є, і що потрібно підготувати для першої версії?'
};

export const basicInterview = () => Object.entries(starter).map(([topic,question])=>({topic,question}));

export function validateInterview(questions, {answers=false}={}) {
  if(!Array.isArray(questions)||questions.length>Object.keys(interviewTopics).length)throw Error('Некоректний список запитань про проєкт');
  const seen=new Set();
  for(const item of questions){
    const {topic,question,answer}=item??{};
    if(!Object.hasOwn(interviewTopics,topic)||seen.has(topic)||typeof question!=='string'||!question.trim()||question.length>320||
      (answers&&answer!==undefined&&(typeof answer!=='string'||answer.length>1200)))throw Error('Некоректне уточнення проєкту');
    seen.add(topic);
  }
  return questions;
}

export function answeredInterview(questions=[]) {
  return questions.flatMap(({topic,question,answer})=>answer?.trim()?[{topic,question,answer:answer.trim()}]:[]);
}

export const needsInterview = draft => draft.mode==='idea'||draft.mode==='auto'&&draft.description.trim().length<220;
