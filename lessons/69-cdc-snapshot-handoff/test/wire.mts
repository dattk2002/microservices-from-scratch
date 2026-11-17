// Transform decoded string tokens only; preserve numbers, booleans and null.
export function escapedJson(value:unknown):string {
 return JSON.stringify(value).replace(/"(?:\\.|[^"\\])*"/g,token=>{
  const decoded:unknown=JSON.parse(token);
  if(typeof decoded!=='string')throw new Error('Expected JSON string token');
  return '"'+decoded.split('').map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
 });
}
