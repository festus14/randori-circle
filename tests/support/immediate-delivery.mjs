// Test doubles for the post-commit immediate delivery path (issue #250).
//
// - The Vercel runtime exposes `waitUntil` through this request-context symbol
//   (see @vercel/functions/get-context). Installing it lets a test observe
//   exactly which background promises a handler registered, and when.
// - Resend is exercised for real down to `fetch`, so the provider idempotency
//   key and request shape are asserted at the network boundary.

const REQUEST_CONTEXT=Symbol.for('@vercel/request-context');

export function installWaitUntilCapture({onRegister=null}={}){
  const previous=globalThis[REQUEST_CONTEXT];
  const promises=[];
  globalThis[REQUEST_CONTEXT]={get:()=>({waitUntil(promise){
    if(onRegister) onRegister(promise);
    promises.push(promise);
  }})};
  return {
    promises,
    async settle(){ return Promise.all(promises.splice(0)); },
    restore(){
      if(previous===undefined) delete globalThis[REQUEST_CONTEXT];
      else globalThis[REQUEST_CONTEXT]=previous;
    },
  };
}

export function stubResendFetch({status=200,delayMs=0,throwError=false}={}){
  const original=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async(url,options={})=>{
    const target=String(url);
    if(!target.startsWith('https://api.resend.com/')) return original(url,options);
    const headers=new Headers(options.headers||{});
    let body={};
    try{ body=JSON.parse(String(options.body||'{}')); }catch{}
    calls.push({url:target,idempotencyKey:headers.get('idempotency-key'),to:body.to,subject:body.subject,html:body.html});
    if(delayMs>0) await new Promise(resolve=>setTimeout(resolve,delayMs));
    if(throwError) throw new TypeError('fetch failed');
    if(status>=200&&status<300){
      return new Response(JSON.stringify({id:`msg_${calls.length}`}),{status,headers:{'content-type':'application/json'}});
    }
    return new Response(JSON.stringify({name:'internal_server_error',message:'provider unavailable',statusCode:status}),
      {status,headers:{'content-type':'application/json'}});
  };
  return {calls,restore(){ globalThis.fetch=original; }};
}
