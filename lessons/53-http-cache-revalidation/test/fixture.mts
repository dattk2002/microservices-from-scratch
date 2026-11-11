// Test-only independent upstream. Controls are unavailable without explicit opt-in.
import {serve,json} from '../../../lib/http.mts';
import {input,bad} from '../runtime.mts';
export function escapedStrings(jsonText:string){
  return jsonText.replace(/"(?:[^"\\]|\\.)*"/g, token=>{
    const decoded:unknown=JSON.parse(token);if(typeof decoded!=='string')throw new Error('Not string');
    return '"'+[...decoded].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
  });
}
export async function main(){
  if(process.env.TEACHING_CONTROLS!=='1')throw new Error('Test fixture requires controls');
  let mode='normal';let destination='';let requests=0;
  return serve('cache-fixture',0,async(req,res)=>{
    if(req.url==='/teaching/mode'&&req.method==='POST'){
      const v=await input(req);if(typeof v.mode!=='string'||!['normal','escaped','oversize','malformed','slow','redirect','bad-age','bad-date','bad-vary','bad-policy','bad-etag','wrong-language','unsolicited'].includes(v.mode))throw bad();
      if(v.mode==='redirect'&&(typeof v.destination!=='string'||! /^http:\/\/127\.0\.0\.1:\d+$/.test(v.destination)))throw bad();
      mode=v.mode;destination=typeof v.destination==='string'?v.destination:'';json(res,200,{mode});return;
    }
    if(req.url==='/teaching/state'){json(res,200,{requests});return;}
    requests=Math.min(1000000,requests+1);
    if(mode==='redirect'){res.writeHead(302,{location:destination+'/document'});res.end();return;}
    const lang=req.headers['accept-language']==='vi'?'vi':'en';
    const body={language:mode==='wrong-language'?'vi':lang,version:1,text:'A'.repeat(32)};
    const headers={etag:mode==='bad-etag'?'"en-2"':`"${lang}-1"`,vary:mode==='bad-vary'?'Cookie':'Accept-Language',date:mode==='bad-date'?'yesterday':new Date(1700000000000).toUTCString(),age:mode==='bad-age'?'-1':'0','cache-control':mode==='bad-policy'?'public':'public,max-age=5,must-revalidate'};
    res.writeHead(mode==='unsolicited'?304:200,headers);
    if(mode==='slow'){res.write(JSON.stringify(body));return;}
    let wire=mode==='escaped'?escapedStrings(JSON.stringify(body)):JSON.stringify(body);
    if(mode==='oversize')wire+=' '.repeat(1025);
    res.end(mode==='malformed'?'{':mode==='unsolicited'?undefined:wire);
  });
}
if(import.meta.main)await main();
