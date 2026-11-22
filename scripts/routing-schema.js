import {mkdir,writeFile,rename,unlink,access} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

export async function routingSchema(plan,candidates,maxAgentsPerTask){
  const routeIds=[...new Set([...candidates.values()].flat().map(r=>r.id))];
  const schema={type:'object',additionalProperties:false,required:['assignments'],properties:{assignments:{type:'array',
    minItems:plan.tasks.length,maxItems:plan.tasks.length,items:{type:'object',additionalProperties:false,
      required:['taskId','routeIds','reason'],properties:{taskId:{type:'string',enum:plan.tasks.map(t=>t.id)},
        routeIds:{type:'array',minItems:1,maxItems:maxAgentsPerTask,items:{type:'string',enum:routeIds}},reason:{type:'string'}}}}}};
  const content=JSON.stringify(schema),directory=fileURLToPath(new URL('../.orchestrator/director/schemas/',import.meta.url));
  await mkdir(directory,{recursive:true});const path=join(directory,createHash('sha256').update(content).digest('hex')+'.json');
  try{await access(path);return path;}catch{}
  const temp=join(directory,`schema-${randomUUID()}.tmp`);
  try{await writeFile(temp,content);await rename(temp,path);}catch(error){await unlink(temp).catch(()=>{});if(error.code!=='EEXIST'&&error.code!=='EPERM')throw error;}
  return path;
}
