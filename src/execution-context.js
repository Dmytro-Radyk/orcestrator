export function skillGuidance(skills = [], hooks = []) {
  const entries=[...hooks,...skills];
  if (!entries.length) return '';
  return '\n\nДовідкові інструкції для задачі. Використовуй доречні кроки в межах задачі, дозволених інструментів і робочої папки. Вимоги користувача та правила виконання мають пріоритет.\n' +
    entries.map(({id,text}) => `\n### ${id}\n${text}`).join('\n');
}

export function workerHandoff(output) {
  const report=output?.report;
  if(report?.status!=='completed'||typeof report.summary!=='string')return output;
  return {
    agentId:output.agentId,
    summary:report.summary,
    files:report.files,
    checks:report.checks?.map(({command,status,required,details})=>({
      command,status,required,...(status!=='passed'?{details}:{})
    }))
  };
}

export function dependencyHandoff(task,isolated) {
  const plain={title:task.title,result:task.result};
  if(!isolated||!task.workspace?.commit||!task.outputs?.length)return plain;
  const outputs=task.outputs.map(workerHandoff);
  if(outputs.some((output,index)=>output===task.outputs[index]))return plain;
  return {title:task.title,commit:task.workspace.commit,outputs};
}
