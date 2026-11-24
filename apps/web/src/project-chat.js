const statusLabels = {
  queued:'У черзі', running:'Виконується', paused:'Призупинено', completed:'Виконано',
  failed:'Помилка виконання', blocked:'Є перешкода', cancelled:'Скасовано',
  interrupted:'Перервано', start_failed:'Очікує повторного запуску'
};
const date = new Intl.DateTimeFormat('uk-UA',{dateStyle:'short',timeStyle:'short'});

export function createProjectChat({request, cancel, refresh, h, button}) {
  const threads = new Map();
  let visible, timer;
  function thread(projectId) {
    if (!threads.has(projectId)) threads.set(projectId,{messages:null, draft:'', error:'', busy:false, request:0});
    return threads.get(projectId);
  }

  function update(projectId, scroll = false) {
    if (visible !== projectId) return;
    const log = document.querySelector('.project-chat-log');
    const atEnd = !log || log.scrollHeight - log.clientHeight - log.scrollTop < 48;
    refresh();
    const nextLog = document.querySelector('.project-chat-log');
    if ((scroll || atEnd) && nextLog) nextLog.scrollTop = nextLog.scrollHeight;
  }

  async function load(projectId) {
    const state = thread(projectId);
    if (state.busy || state.loading) return;
    state.loading = true;
    const version = state.request;
    try {
      const {messages} = await request(projectId);
      if (version !== state.request) return;
      if (JSON.stringify(state.messages) === JSON.stringify(messages) && !state.loadError) return;
      state.messages = messages;
      state.loadError = '';
      update(projectId);
    } catch (error) {
      if (version !== state.request || state.loadError === error.message) return;
      state.loadError = error.message;
      update(projectId);
    } finally { state.loading = false; }
  }

  async function submit(projectId, operation, onSuccess) {
    const state = thread(projectId);
    if (state.busy) return;
    state.busy = true;
    state.request++;
    state.error = '';
    update(projectId);
    try {
      const response = await operation();
      if (response?.messages) state.messages = response.messages;
      state.loadError = '';
      onSuccess?.(state);
    } catch (error) { state.error = error.message; }
    finally {
      state.busy = false;
      update(projectId, Boolean(onSuccess && !state.error));
    }
  }

  function renderMessage(message) {
    return `<article class="project-chat-exchange" data-live-key="chat-${h(message.id)}">
      <div class="project-chat-user"><div class="project-chat-meta"><strong>Ви</strong><time datetime="${h(message.createdAt)}">${h(date.format(new Date(message.createdAt)))}</time></div><p>${h(message.text)}</p></div>
      <div class="project-chat-reply"><div class="project-chat-meta"><strong>Оркестратор</strong><span role="status">${h(statusLabels[message.status] ?? message.status)}</span>${message.model?`<span>${h(message.model)}</span>`:''}</div>
        ${message.result||message.problem||message.error?`<p>${h(message.result??message.problem??message.error)}</p>`:''}
        ${message.selfReview?`<details><summary>Самоперевірка · ${message.selfReview.approved?'схвалено':'потрібні правки'}</summary><p>${h(message.selfReview.feedback)}</p></details>`:''}
        <div class="project-chat-actions">
          ${message.runId?button('view-run','Деталі запуску','file','btn',`data-id="${h(message.runId)}"`):''}
          ${['running','paused'].includes(message.status)?button('chat-cancel','Зупинити','stop','btn',`data-id="${h(message.runId)}"`):''}
          ${message.status==='start_failed'?button('chat-retry','Повторити запуск','play','btn',`data-id="${h(message.id)}"`):''}
          ${message.status==='start_failed'&&message.decisionCode==='free_chat_unavailable'?button('chat-retry-subscription','Дозволити підписку для цього запиту','shield','btn',`data-id="${h(message.id)}"`):''}
        </div>
      </div>
    </article>`;
  }

  return {
    show(projectId) {
      if (visible === projectId) return;
      visible = projectId;
      clearInterval(timer);
      if (!projectId) return;
      void load(projectId);
      timer = setInterval(() => void load(projectId), 3000);
    },
    edit(projectId,text) { thread(projectId).draft = text; },
    send(projectId,input) {
      const state = thread(projectId);
      if (state.busy) return;
      const text = input.value.trim();
      if (!text) { input.setCustomValidity('Напишіть, що потрібно змінити.'); input.reportValidity(); return; }
      state.draft = input.value;
      if (state.pending?.text !== text) state.pending = {id:crypto.randomUUID(),text};
      return submit(projectId, () => request(projectId,state.pending),current=>{
        current.pending = undefined;
        if (current.draft.trim() === text) {
          current.draft = '';
          if (input.isConnected) input.value = '';
        }
      });
    },
    retry(projectId,id,extra={}) { return submit(projectId, () => request(projectId,{id,retry:true,...extra})); },
    async cancel(projectId,id) { await submit(projectId, () => cancel(id)); await load(projectId); },
    panel(projectId,ready) {
      const state = thread(projectId);
      const empty = state.messages ? 'Тут з’являться ваші запити й результати роботи.' :
        state.loadError ? 'Не вдалося завантажити історію.' : 'Завантажуємо історію…';
      return `<section class="panel project-chat" data-live-key="project-chat-${h(projectId)}" aria-labelledby="project-chat-heading">
        <div class="panel-heading"><h2 id="project-chat-heading">Чат проєкту</h2>${button('project-preview','Перегляд проєкту','link')}</div>
        <div class="project-chat-log" data-live-key="project-chat-log" role="log" aria-label="Історія чату" tabindex="0">
          ${state.messages?.length?state.messages.map(renderMessage).join(''):`<p class="muted project-chat-empty">${empty}</p>`}
        </div>
        <form id="project-chat-form" class="project-chat-form" aria-busy="${state.busy}">
          <label for="project-chat-message">Що потрібно змінити?</label>
          <textarea id="project-chat-message" name="message" rows="3" maxlength="6000" required aria-describedby="project-chat-hint" placeholder="Наприклад, додай пошук або перероби головну сторінку">${h(state.draft)}</textarea>
          <div class="project-chat-footer"><p id="project-chat-hint" class="muted">Якщо команда вже працює, запит стане в чергу.</p><button class="btn primary" type="submit" ${!ready||state.busy?'disabled':''}>${state.busy?'Зачекайте…':'Надіслати правки'}</button></div>
          <p class="project-chat-error" role="alert">${h(state.error || state.loadError)}</p>
        </form>
      </section>`;
    }
  };
}
