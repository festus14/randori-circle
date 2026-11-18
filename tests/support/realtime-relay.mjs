import { generateKeyPairSync } from 'node:crypto';

export const RELAY_ENV_KEYS=['REALTIME_RELAY_ENABLED','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_REALTIME_SIGNING_JWK','SUPABASE_REALTIME_SIGNING_KID','RANDORI_LOCAL_RUNTIME'];
export const RELAY_IDENTITY={roomId:'week_10_pair_20',weekId:10,pairGroupId:20,
  questionSlug:'focus-block-rollup',questionVersion:1,language:'javascript'};
export const RELAY_BODY={room_id:'week_10_pair_20',question_slug:'focus-block-rollup',question_version:1,language:'javascript'};
export const RELAY_PAIR={userAId:1,userBId:2};

export function relayKeyFixture(){
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const jwk=privateKey.export({format:'jwk'});
  const env={REALTIME_RELAY_ENABLED:'true',SUPABASE_URL:'https://relay-test.supabase.co',
    SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test_public_key_461',
    SUPABASE_REALTIME_SIGNING_JWK:JSON.stringify(jwk),SUPABASE_REALTIME_SIGNING_KID:'relay-test-kid'};
  return {env,jwk,privateKey,publicKey};
}

export function fakeRelayClock(start=1_800_000_000_000){
  let time=start,nextId=0;
  const timers=new Map();
  return {
    now:()=>time,
    setTimer(fn,delay=0){ const id=++nextId; timers.set(id,{fn,due:time+delay}); return id; },
    clearTimer:id=>timers.delete(id),
    advance(ms){
      const end=time+ms;
      for(let count=0;count<10000;count+=1){
        const next=[...timers].filter(([,timer])=>timer.due<=end).sort((a,b)=>a[1].due-b[1].due||a[0]-b[0])[0];
        if(!next){ time=end; return; }
        const [id,timer]=next; time=timer.due; timers.delete(id); timer.fn();
      }
      throw new Error('fake relay timer loop');
    },
    get pending(){ return timers.size; },
  };
}

export function mockRelaySockets({clock,latency=30,autoOpen=true,joinStatus='ok'}={}){
  const sockets=[];
  class Socket{
    readyState=0; bufferedAmount=0; sent=[]; closes=0;
    constructor(url){
      this.url=url; sockets.push(this);
      if(autoOpen) clock.setTimer(()=>this.open(),0);
    }
    open(){ if(this.readyState===3) return; this.readyState=1; this.onopen?.(); }
    deliver(frame){ this.onmessage?.({data:typeof frame==='string'?frame:JSON.stringify(frame)}); }
    send(raw){
      const frame=JSON.parse(raw); this.sent.push(frame);
      if(frame.event==='phx_join'){
        this.topic=frame.topic;
        clock.setTimer(()=>this.deliver({topic:frame.topic,event:'phx_reply',ref:frame.ref,join_ref:frame.join_ref,
          payload:{status:joinStatus,response:{}}}),latency);
      }else if(frame.event==='heartbeat'){
        clock.setTimer(()=>this.deliver({topic:'phoenix',event:'phx_reply',ref:frame.ref,payload:{status:'ok'}}),latency);
      }else if(frame.event==='broadcast'){
        for(const peer of sockets){
          if(peer!==this&&peer.readyState===1&&peer.topic===this.topic) clock.setTimer(()=>peer.deliver({
            topic:frame.topic,event:'broadcast',payload:frame.payload,ref:null,join_ref:'1',
          }),latency);
        }
      }
    }
    close(){ this.closes+=1; this.readyState=3; this.onclose?.(); }
  }
  return {Socket,sockets};
}

export function mockRelayConfiguration(room='week_10_pair_20',clock={now:Date.now}){
  return {ok:true,url:'https://relay-test.supabase.co',publishable_key:'sb_publishable_test_public_key_461',
    topic:`rc-code:v1:${room}:${'a'.repeat(64)}`,token:'header.payload.signature',expires_at:Math.floor(clock.now()/1000)+300};
}

export async function settleRelayPromises(){ for(let index=0;index<8;index+=1) await Promise.resolve(); }
