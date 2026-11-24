import { pathToFileURL } from 'node:url';

const {startFixture}=await import(pathToFileURL(process.argv[2]).href);
const preview=await startFixture();
let closing=false;
async function close(){
  if(closing)return;
  closing=true;
  try{await preview.close();}
  finally{if(process.connected)process.disconnect();}
}
process.on('message',message=>{if(message==='close-preview')void close();});
process.once('disconnect',()=>void close());
process.once('SIGTERM',()=>void close());
console.log(JSON.stringify({mode:'TEST_ONLY',externalCalls:false,url:preview.origin}));
