import * as Y from 'yjs';
import { RELAY_UPDATE_LIMIT } from './realtime-relay.mjs';

// A relay peer is not the durable server. Validate on a disposable copy before
// touching the live editor, so corrupt/rich/extra-root/oversized input cannot
// poison its state or bypass the HTTPS document's plain-text bounds.
export function applyValidatedRelayUpdate(doc,update,origin){
  if(!(update instanceof Uint8Array)||update.byteLength<1||update.byteLength>RELAY_UPDATE_LIMIT) return false;
  const candidate=new Y.Doc({gc:true});
  try{
    Y.applyUpdate(candidate,Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(candidate,update);
    const text=candidate.getText('code');
    if(candidate.share.size!==1||!(text instanceof Y.Text)
      ||text.toDelta().some(operation=>typeof operation.insert!=='string'||Object.keys(operation).some(key=>key!=='insert'))
      ||new TextEncoder().encode(text.toString()).byteLength>20*1024
      ||Y.encodeStateAsUpdate(candidate).byteLength>256*1024) return false;
    Y.applyUpdate(doc,update,origin);
    return true;
  }catch{ return false; }
  finally{ candidate.destroy(); }
}
