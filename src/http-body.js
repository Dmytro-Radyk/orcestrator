export async function readJsonBody(request,{maxBytes=1024*1024,limitMessage='Request too large',requireObject=true}={}) {
  const chunks=[];let size=0;
  for await(const chunk of request){
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    size+=bytes.length;if(size>maxBytes)throw Object.assign(new Error(limitMessage),{statusCode:413});
    chunks.push(bytes);
  }
  // Network chunks can end in the middle of a UTF-8 code point. Decode once,
  // after joining bytes, and reject invalid input instead of storing replacements.
  const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size));
  const value=text?JSON.parse(text):{};
  if(requireObject&&(!value||typeof value!=='object'||Array.isArray(value)))throw new Error('Expected a JSON object');
  return value;
}
