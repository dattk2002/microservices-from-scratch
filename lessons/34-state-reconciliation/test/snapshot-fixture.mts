import { serve, json } from '../../../lib/http.mts';
// HTTP dependency fixture; never starts during test discovery/import.
if (import.meta.main) {
  let hits = 0;
  await serve('snapshot-fixture',0,(req,res) => {
    if (req.url === '/hits') { json(res,200,{hits}); return; }
    hits++;
    if (process.env.MODE === 'redirect') {
      res.writeHead(process.env.REDIRECT_CODE === '308' ? 308 : 307,{location:`${process.env.TARGET}${req.url}`});
      res.end();
    } else if (process.env.MODE === 'valid') json(res,200,[{id:'a',version:1,value:'valid'}]);
    else if (process.env.MODE === 'oversize') {
      res.writeHead(200,{'content-type':'application/json'});
      res.end('[{"id":"a","version":1,"value":"ok"}]'+' '.repeat(30001));
    } else json(res,200,[{id:'a',version:1,value:true}]);
  });
}
