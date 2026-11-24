export function recentRunNotifications(runs,{limit=60}={}){
  const notifications=new Map();
  for(const run of runs){
    const stages=new Map(run.tasks.filter(task=>!task.parentId).map(task=>[task.id,task]));
    for(const event of run.events){
      let kind,title,body,id;
      if(event.type==='run.completed'||event.type==='run.failed'){
        kind=event.type==='run.failed'?'failed':'completed';
        title=kind==='failed'?'Запуск завершився помилкою':event.testCompletion?'Тестовий запуск завершено':'Проєкт завершено';
        body=run.project.name;
        id=`${run.id}:${event.id??event.at}:${kind}`;
      }else if(['task.completed','task.host_verified'].includes(event.type)&&stages.has(event.taskId)){
        kind='stage';
        title='Етап завершено';
        body=`${run.project.name} · ${stages.get(event.taskId).title}`;
        id=`${run.id}:stage:${event.taskId}`;
      }else continue;
      notifications.set(id,{id,kind,title,body,at:event.at,projectId:run.project.uiProjectId});
    }
  }
  return [...notifications.values()].sort((a,b)=>a.at.localeCompare(b.at)).slice(-limit);
}
